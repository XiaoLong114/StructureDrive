"""方块云盘 — a small Minecraft structure cloud drive.

Flask application with a public read-only file browser, an admin account for
uploads / folders / renames / deletes, and a WebGL 3-D structure previewer.

Run:
    python app.py
Default admin:
    admin / admin123   (override with MCCLOUD_ADMIN_PASSWORD)
"""

from __future__ import annotations

import gzip
import hmac
import mimetypes
import os
import re
import secrets
import sqlite3
import struct
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from functools import lru_cache, wraps
from pathlib import Path
from urllib.parse import urlparse

from flask import (
    Flask,
    abort,
    flash,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

mimetypes.add_type("application/wasm", ".wasm")

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("MCCLOUD_DATA", BASE_DIR / "data")).resolve()
UPLOAD_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "mccloud.db"
SECRET_PATH = DATA_DIR / "secret_key"

ADMIN_USERNAME = os.environ.get("MCCLOUD_ADMIN_USER", "admin")
ADMIN_PASSWORD_ENV = os.environ.get("MCCLOUD_ADMIN_PASSWORD")
ADMIN_PASSWORD = ADMIN_PASSWORD_ENV or "admin123"

ALLOWED_EXTS = {
    "mcstructure",
    "litematic",
    "schem",
    "wsmr",
    "bdx",
    "nbt",
    "schematic",
    "mcworld",
    "mcpack",
    "mcaddon",
}
JAVA_EXTS = {"schematic", "schem", "litematic", "nbt"}
BEDROCK_EXTS = {"mcstructure", "mcpack", "mcaddon"}
WORLD_EXTS = {"mcworld"}
EXT_ACCEPT = ",".join("." + e for e in sorted(ALLOWED_EXTS))

MAX_UPLOAD_BYTES = int(os.environ.get("MCCLOUD_MAX_UPLOAD_MB", "1024")) * 1024 * 1024

# Large static assets are served pre-compressed when the browser supports it.
# This keeps the first mobile load ~10 MB smaller.
GZIP_STATIC = {
    "/static/gen/bake.bin": ("gen/bake.bin.gz", "application/octet-stream"),
    "/static/gen/bake_meta.json": ("gen/bake_meta.json.gz", "application/json"),
    "/static/wasm/core.wasm": ("wasm/core.wasm.gz", "application/wasm"),
    "/static/vendor/three/three.module.min.js": (
        "vendor/three/three.module.min.js.gz",
        "text/javascript",
    ),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    password_changed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT UNIQUE NOT NULL,
    folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_ext ON files(ext);
"""

INVALID_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


# --------------------------------------------------------------------------
# storage + db helpers
# --------------------------------------------------------------------------
def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def load_secret_key() -> str:
    env = os.environ.get("MCCLOUD_SECRET_KEY")
    if env:
        return env
    ensure_dirs()
    if SECRET_PATH.exists():
        return SECRET_PATH.read_text(encoding="utf-8").strip()
    key = secrets.token_hex(32)
    SECRET_PATH.write_text(key, encoding="utf-8")
    return key


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        g.db.execute("PRAGMA journal_mode = WAL")
    return g.db


def close_db(_exc=None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db() -> None:
    ensure_dirs()
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA)
    user_columns = {column[1] for column in db.execute("PRAGMA table_info(users)")}
    if "password_changed" not in user_columns:
        db.execute(
            "ALTER TABLE users ADD COLUMN password_changed INTEGER NOT NULL DEFAULT 0"
        )
    now = datetime.now(timezone.utc).isoformat()
    row = db.execute("SELECT * FROM users WHERE username = ?", (ADMIN_USERNAME,)).fetchone()
    if row is None:
        # The admin may have changed their username from the web UI. In that
        # case keep the existing admin instead of recreating the default one.
        row = db.execute(
            "SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1"
        ).fetchone()
    if row is None:
        db.execute(
            "INSERT INTO users (username, password_hash, is_admin, password_changed, created_at) "
            "VALUES (?,?,1,?,?)",
            (
                ADMIN_USERNAME,
                generate_password_hash(ADMIN_PASSWORD),
                1 if ADMIN_PASSWORD_ENV else 0,
                now,
            ),
        )
    elif ADMIN_PASSWORD_ENV:
        # An explicitly configured password always wins, so it can be reset.
        if not check_password_hash(row["password_hash"], ADMIN_PASSWORD):
            db.execute(
                "UPDATE users SET password_hash = ?, is_admin = 1, password_changed = 1 "
                "WHERE id = ?",
                (generate_password_hash(ADMIN_PASSWORD), row["id"]),
            )
    db.commit()
    db.close()


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    row = get_db().execute(
        "SELECT id, username, is_admin FROM users WHERE id = ?", (uid,)
    ).fetchone()
    if row is None:
        session.clear()
    return row


def is_admin() -> bool:
    user = current_user()
    return bool(user and user["is_admin"])


def login_password_hint() -> bool:
    """Only show the initial credentials while they have never been changed."""
    if ADMIN_PASSWORD_ENV:
        return False
    row = get_db().execute(
        "SELECT password_changed FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1"
    ).fetchone()
    return bool(row) and not row["password_changed"]


def csrf_token() -> str:
    token = session.get("_csrf")
    if not token:
        token = secrets.token_urlsafe(32)
        session["_csrf"] = token
    return token


def require_csrf() -> None:
    sent = request.headers.get("X-CSRF-Token") or request.form.get("_csrf", "")
    expected = session.get("_csrf", "")
    if not sent or not expected or not hmac.compare_digest(str(sent), str(expected)):
        abort(400, description="CSRF token 无效，请刷新页面后重试。")


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not is_admin():
            if request.path.startswith("/api/"):
                return jsonify(ok=False, error="需要管理员登录。"), 401
            return redirect(url_for("login", next=request.full_path))
        return view(*args, **kwargs)

    return wrapped


def safe_next(target: str | None) -> str:
    if not target:
        return url_for("drive")
    parsed = urlparse(target)
    if parsed.scheme or parsed.netloc or not target.startswith("/") or target.startswith("//"):
        return url_for("drive")
    return target


def clean_name(raw: str, *, fallback: str = "未命名") -> str:
    name = (raw or "").replace("\\", "/").split("/")[-1].strip()
    name = INVALID_NAME.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    if not name or name in {".", ".."}:
        name = fallback
    if len(name) > 120:
        stem, ext = os.path.splitext(name)
        name = stem[: max(1, 120 - len(ext))] + ext[:20]
    return name


def split_ext(name: str) -> tuple[str, str]:
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        return name, ""
    return stem, ext.lower()


def unique_file_name(db: sqlite3.Connection, folder_id: int | None, name: str) -> str:
    stem, ext = split_ext(name)
    suffix = f".{ext}" if ext else ""
    candidate = name
    n = 2
    while db.execute(
        "SELECT 1 FROM files WHERE folder_id IS ? AND name = ?", (folder_id, candidate)
    ).fetchone():
        candidate = f"{stem} ({n}){suffix}"
        n += 1
    return candidate


def folder_chain(folder_id: int | None) -> list[sqlite3.Row]:
    chain: list[sqlite3.Row] = []
    guard = 0
    while folder_id:
        guard += 1
        if guard > 100:
            abort(400)
        row = get_db().execute(
            "SELECT id, name, parent_id FROM folders WHERE id = ?", (folder_id,)
        ).fetchone()
        if row is None:
            abort(404)
        chain.append(row)
        folder_id = row["parent_id"]
    chain.reverse()
    return chain


def unique_folder_name(db: sqlite3.Connection, parent_id: int | None, name: str) -> str:
    candidate = name
    n = 2
    while db.execute(
        "SELECT 1 FROM folders WHERE parent_id IS ? AND name = ?", (parent_id, candidate)
    ).fetchone():
        candidate = f"{name} ({n})"
        n += 1
    return candidate


def human_size(num: int) -> str:
    size = float(num or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            if unit == "B":
                return f"{int(size)} B"
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def human_date(iso: str) -> str:
    try:
        dt = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone()
    now = datetime.now(timezone.utc)
    delta = now - dt
    if delta < timedelta(minutes=1):
        return "刚刚"
    if delta < timedelta(hours=1):
        return f"{int(delta.total_seconds() // 60)} 分钟前"
    if delta < timedelta(days=1):
        return f"{int(delta.total_seconds() // 3600)} 小时前"
    if delta < timedelta(days=7):
        return f"{delta.days} 天前"
    if local.year == now.astimezone().year:
        return local.strftime("%m月%d日")
    return local.strftime("%Y-%m-%d")


def ext_family(ext: str) -> str:
    if ext in JAVA_EXTS:
        return "java"
    if ext in BEDROCK_EXTS:
        return "bedrock"
    if ext in WORLD_EXTS:
        return "world"
    return "other"


def ext_label(ext: str) -> str:
    return {
        "schematic": "Schematic",
        "schem": "Sponge",
        "litematic": "Litematica",
        "mcstructure": "Bedrock",
        "mcworld": "World",
        "mcpack": "Pack",
        "mcaddon": "Add-on",
        "nbt": "NBT",
        "wsmr": "WSMR",
        "bdx": "BDX",
    }.get(ext, ext.upper())


def folder_path_label(folder_id: int | None, names: dict[int, tuple[int | None, str]]) -> str:
    parts: list[str] = []
    guard = 0
    while folder_id and guard < 100:
        guard += 1
        row = names.get(folder_id)
        if not row:
            break
        parts.append(row[1])
        folder_id = row[0]
    return " / ".join(reversed(parts))


def _nbt_read_name(data: bytes, offset: int) -> tuple[str, int]:
    length = struct.unpack_from(">H", data, offset)[0]
    offset += 2
    name = data[offset : offset + length].decode("utf-8", "replace")
    return name, offset + length


def _nbt_skip_payload(data: bytes, offset: int, tag: int, depth: int = 0) -> int:
    if depth > 8:
        raise ValueError("nbt too deep")
    if tag == 0:
        return offset
    if tag == 1:
        return offset + 1
    if tag == 2:
        return offset + 2
    if tag == 3:
        return offset + 4
    if tag == 4:
        return offset + 8
    if tag == 5:
        return offset + 4
    if tag == 6:
        return offset + 8
    if tag == 7:
        length = struct.unpack_from(">i", data, offset)[0]
        return offset + 4 + length
    if tag == 8:
        length = struct.unpack_from(">H", data, offset)[0]
        return offset + 2 + length
    if tag == 9:
        element = data[offset]
        length = struct.unpack_from(">i", data, offset + 1)[0]
        offset += 5
        for _ in range(max(0, length)):
            offset = _nbt_skip_payload(data, offset, element, depth + 1)
        return offset
    if tag == 10:
        while True:
            child = data[offset]
            offset += 1
            if child == 0:
                return offset
            _, offset = _nbt_read_name(data, offset)
            offset = _nbt_skip_payload(data, offset, child, depth + 1)
    if tag == 11:
        length = struct.unpack_from(">i", data, offset)[0]
        return offset + 4 + 4 * length
    if tag == 12:
        length = struct.unpack_from(">i", data, offset)[0]
        return offset + 4 + 8 * length
    raise ValueError(f"unknown nbt tag {tag}")


@lru_cache(maxsize=256)
def _probe_size_cached(path_str: str, mtime_ns: int):
    raw = Path(path_str).read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    elif raw[:1] == b"\x78":
        raw = zlib.decompress(raw)
    if not raw or raw[0] != 10:
        return None
    offset = 1
    _, offset = _nbt_read_name(raw, offset)
    dims = {"width": None, "height": None, "length": None}
    while True:
        tag = raw[offset]
        offset += 1
        if tag == 0:
            break
        name, offset = _nbt_read_name(raw, offset)
        key = name.strip().lower()
        if tag in (2, 3) and key in dims:
            size = 2 if tag == 2 else 4
            value = int.from_bytes(raw[offset : offset + size], "big", signed=True)
            dims[key] = value
            offset += size
        else:
            offset = _nbt_skip_payload(raw, offset, tag)
    if all(isinstance(v, int) and 0 < v < 100000 for v in dims.values()):
        return dims["width"], dims["height"], dims["length"]
    return None


def probe_structure_size(path: Path):
    """Read Width/Height/Length from schematic NBT without loading the world."""
    try:
        stat = path.stat()
        return _probe_size_cached(str(path), stat.st_mtime_ns)
    except Exception:
        return None


def choose_default_lod(size, file_size: int) -> int:
    if size:
        volume = size[0] * size[1] * size[2]
        if volume > 200_000_000:
            return 8
        if volume > 80_000_000:
            return 4
        if volume > 8_000_000:
            return 2
        return 1
    if file_size > 8 * 1024 * 1024:
        return 4
    if file_size > 512 * 1024:
        return 2
    return 1


def get_file_or_404(file_id: int):
    row = get_db().execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is None:
        abort(404)
    return row


# --------------------------------------------------------------------------
# app factory
# --------------------------------------------------------------------------
def create_app() -> Flask:
    init_db()
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=load_secret_key(),
        MAX_CONTENT_LENGTH=MAX_UPLOAD_BYTES,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=False,
        JSON_AS_ASCII=False,
    )
    app.teardown_appcontext(close_db)

    @app.before_request
    def serve_precompressed_static():
        entry = GZIP_STATIC.get(request.path)
        if not entry:
            return None
        if "gzip" not in (request.headers.get("Accept-Encoding") or "").lower():
            return None
        compressed = BASE_DIR / "static" / entry[0]
        if not compressed.is_file():
            return None
        response = send_file(
            compressed,
            mimetype=entry[1],
            conditional=True,
            max_age=86400,
        )
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Vary"] = "Accept-Encoding"
        response.headers["Cache-Control"] = "public, max-age=86400"
        return response

    app.jinja_env.filters["size"] = human_size
    app.jinja_env.filters["date"] = human_date
    app.jinja_env.globals.update(
        ext_family=ext_family,
        ext_label=ext_label,
        allowed_exts=sorted(ALLOWED_EXTS),
        ext_accept=EXT_ACCEPT,
    )

    @app.context_processor
    def inject_globals():
        user = current_user()
        return {
            "current_user": user,
            "is_admin": bool(user and user["is_admin"]),
            "csrf_token": csrf_token(),
        }

    @app.after_request
    def security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; "
            "worker-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "connect-src 'self'; "
            "font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
        )
        return response

    @app.errorhandler(400)
    def bad_request(err):
        if request.path.startswith("/api/"):
            return jsonify(ok=False, error=getattr(err, "description", "请求无效")), 400
        return render_template("error.html", code=400, message=getattr(err, "description", "请求无效")), 400

    @app.errorhandler(401)
    def unauthorized(err):
        if request.path.startswith("/api/"):
            return jsonify(ok=False, error="需要管理员登录。"), 401
        return redirect(url_for("login", next=request.full_path))

    @app.errorhandler(404)
    def not_found(err):
        if request.path.startswith("/api/"):
            return jsonify(ok=False, error="未找到。"), 404
        return render_template("error.html", code=404, message="这个位置不存在，可能已被移动或删除。"), 404

    @app.errorhandler(413)
    def too_large(err):
        limit = human_size(MAX_UPLOAD_BYTES)
        if request.path.startswith("/api/"):
            return jsonify(ok=False, error=f"文件超过 {limit} 上传上限。"), 413
        return render_template("error.html", code=413, message=f"文件超过 {limit} 上传上限。"), 413

    @app.errorhandler(500)
    def server_error(err):
        if request.path.startswith("/api/"):
            return jsonify(ok=False, error="服务器内部错误。"), 500
        return render_template("error.html", code=500, message="服务器开小差了，请稍后重试。"), 500

    # ------------------------------------------------------------------
    # auth
    # ------------------------------------------------------------------
    @app.get("/login")
    def login():
        if is_admin():
            return redirect(url_for("drive"))
        return render_template(
            "login.html",
            next=request.args.get("next", ""),
            error=None,
            default_password_hint=login_password_hint(),
        )

    @app.post("/login")
    def login_post():
        require_csrf()
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        row = get_db().execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if row and row["is_admin"] and check_password_hash(row["password_hash"], password):
            session.clear()
            session["uid"] = row["id"]
            session.permanent = True
            csrf_token()
            flash("已登录管理员模式", "success")
            return redirect(safe_next(request.form.get("next")))
        return render_template(
            "login.html",
            next=request.form.get("next", ""),
            username=username,
            error="账号或密码不正确，请重试。",
            default_password_hint=login_password_hint(),
        ), 401

    @app.post("/logout")
    def logout():
        require_csrf()
        session.clear()
        flash("已退出管理员模式", "success")
        return redirect(url_for("drive"))

    # ------------------------------------------------------------------
    # drive
    # ------------------------------------------------------------------
    @app.get("/")
    def index():
        return redirect(url_for("drive"))

    @app.get("/drive")
    def drive():
        db = get_db()
        folder_id = request.args.get("folder", type=int)
        query = (request.args.get("q") or "").strip()
        sort = request.args.get("sort") or "name"
        direction = request.args.get("dir") or ("desc" if sort == "new" else "asc")

        if sort not in ("name", "new", "size"):
            sort = "name"
        if direction not in ("asc", "desc"):
            direction = "asc"

        if query:
            # Search is global, so don't imply a folder context in the trail.
            folder_id = None
        chain = folder_chain(folder_id) if folder_id else []
        current = chain[-1] if chain else None

        all_folders = db.execute("SELECT id, name, parent_id FROM folders").fetchall()
        folder_map = {r["id"]: (r["parent_id"], r["name"]) for r in all_folders}

        if query:
            qlike = f"%{query}%"
            folders = db.execute(
                "SELECT * FROM folders WHERE name LIKE ? ORDER BY name COLLATE NOCASE LIMIT 200",
                (qlike,),
            ).fetchall()
            files = db.execute(
                "SELECT * FROM files WHERE name LIKE ? ORDER BY created_at DESC LIMIT 500",
                (qlike,),
            ).fetchall()
            page_title = f"“{query}” 的搜索结果"
        else:
            if current:
                folders = db.execute(
                    "SELECT * FROM folders WHERE parent_id = ? ORDER BY name COLLATE NOCASE",
                    (current["id"],),
                ).fetchall()
            else:
                folders = db.execute(
                    "SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name COLLATE NOCASE"
                ).fetchall()
            order = {
                "name": "name COLLATE NOCASE",
                "new": "created_at",
                "size": "size",
            }[sort]
            files = db.execute(
                f"SELECT * FROM files WHERE folder_id IS ? "
                f"ORDER BY {order} {'DESC' if direction == 'desc' else 'ASC'}",
                (current["id"] if current else None,),
            ).fetchall()
            page_title = current["name"] if current else "全部文件"

        # attach display helpers
        folder_rows = []
        for row in folders:
            item = dict(row)
            item["path_label"] = folder_path_label(row["parent_id"], folder_map)
            item["count"] = db.execute(
                "SELECT (SELECT COUNT(*) FROM files WHERE folder_id = ?) + "
                "(SELECT COUNT(*) FROM folders WHERE parent_id = ?) AS n",
                (row["id"], row["id"]),
            ).fetchone()["n"]
            folder_rows.append(item)

        file_rows = []
        for row in files:
            item = dict(row)
            item["path_label"] = folder_path_label(row["folder_id"], folder_map)
            item["family"] = ext_family(row["ext"])
            item["label"] = ext_label(row["ext"])
            file_rows.append(item)

        stats_row = db.execute(
            "SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM files"
        ).fetchone()
        folders_total = db.execute("SELECT COUNT(*) AS n FROM folders").fetchone()["n"]
        stats = {
            "files": stats_row["files"],
            "folders": folders_total,
            "bytes": stats_row["bytes"],
        }

        view = request.args.get("view", "grid")
        if view not in ("grid", "list"):
            view = "grid"

        return render_template(
            "drive.html",
            chain=chain,
            current=current,
            folder_rows=folder_rows,
            file_rows=file_rows,
            page_title=page_title,
            query=query,
            sort=sort,
            direction=direction,
            view=view,
            stats=stats,
            search_mode=bool(query),
        )

    # ------------------------------------------------------------------
    # preview + raw files
    # ------------------------------------------------------------------
    @app.get("/preview/<int:file_id>")
    def preview(file_id: int):
        row = get_file_or_404(file_id)
        chain = folder_chain(row["folder_id"]) if row["folder_id"] else []
        structure_size = probe_structure_size(UPLOAD_DIR / row["stored_name"])
        default_lod = choose_default_lod(structure_size, row["size"])
        return render_template(
            "preview.html",
            file=row,
            chain=chain,
            label=ext_label(row["ext"]),
            family=ext_family(row["ext"]),
            structure_size=structure_size,
            default_lod=default_lod,
        )

    @app.get("/file/<int:file_id>/raw")
    def raw_file(file_id: int):
        row = get_file_or_404(file_id)
        path = UPLOAD_DIR / row["stored_name"]
        if not path.is_file():
            abort(404)
        response = send_file(
            path,
            mimetype="application/octet-stream",
            as_attachment=False,
            download_name=row["name"],
            conditional=True,
            max_age=3600,
        )
        response.headers["Cache-Control"] = "private, max-age=3600"
        return response

    # ------------------------------------------------------------------
    # admin JSON API
    # ------------------------------------------------------------------
    @app.post("/api/folders")
    @admin_required
    def api_create_folder():
        require_csrf()
        payload = request.get_json(silent=True) or {}
        name = clean_name(payload.get("name") or "", fallback="")
        if not name:
            return jsonify(ok=False, error="请输入文件夹名称。"), 400
        parent_id = payload.get("parent_id")
        parent_id = int(parent_id) if parent_id not in (None, "", 0, "0") else None
        if parent_id is not None:
            folder_chain(parent_id)  # validates
        db = get_db()
        final_name = unique_folder_name(db, parent_id, name)
        cur = db.execute(
            "INSERT INTO folders (name, parent_id, created_by, created_at) VALUES (?,?,?,?)",
            (final_name, parent_id, current_user()["id"], utcnow()),
        )
        db.commit()
        return jsonify(ok=True, folder={"id": cur.lastrowid, "name": final_name})

    @app.post("/api/account")
    @admin_required
    def api_account():
        require_csrf()
        payload = request.get_json(silent=True) or {}
        current_password = payload.get("current_password") or ""
        new_username = (payload.get("username") or "").strip()
        new_password = payload.get("new_password") or ""
        confirm_password = payload.get("confirm_password") or ""

        user = current_user()
        db = get_db()
        row = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
        if not row or not check_password_hash(row["password_hash"], current_password):
            return jsonify(ok=False, error="当前密码不正确。"), 400

        if not re.fullmatch(r"[\w.-]{2,32}", new_username, re.UNICODE):
            return jsonify(
                ok=False,
                error="用户名需为 2–32 个字符，仅限中英文、数字、下划线、点或短横线。",
            ), 400

        if new_password or confirm_password:
            if len(new_password) < 6:
                return jsonify(ok=False, error="新密码至少需要 6 个字符。"), 400
            if new_password != confirm_password:
                return jsonify(ok=False, error="两次输入的新密码不一致。"), 400

        if new_username == row["username"] and not new_password:
            return jsonify(ok=False, error="用户名和密码均未修改。"), 400

        if new_username != row["username"]:
            clash = db.execute(
                "SELECT 1 FROM users WHERE username = ? AND id != ?",
                (new_username, row["id"]),
            ).fetchone()
            if clash:
                return jsonify(ok=False, error="这个用户名已被使用。"), 409

        if new_password:
            db.execute(
                "UPDATE users SET username = ?, password_hash = ?, password_changed = 1 "
                "WHERE id = ?",
                (new_username, generate_password_hash(new_password), row["id"]),
            )
        else:
            db.execute(
                "UPDATE users SET username = ?, password_changed = 1 WHERE id = ?",
                (new_username, row["id"]),
            )
        db.commit()
        return jsonify(ok=True, username=new_username, password_changed=bool(new_password))

    @app.post("/api/upload")
    @admin_required
    def api_upload():
        require_csrf()
        folder_id = request.form.get("folder_id", type=int) or None
        if folder_id:
            folder_chain(folder_id)
        uploads = request.files.getlist("files")
        if not uploads:
            return jsonify(ok=False, error="没有收到文件。"), 400

        db = get_db()
        user_id = current_user()["id"]
        saved = []
        errors = []
        for storage in uploads:
            original = clean_name(storage.filename or "", fallback="structure")
            stem, ext = split_ext(original)
            ext = ext.lower()
            if ext not in ALLOWED_EXTS:
                errors.append(f"{original}: 不支持 .{ext or '?'} 格式")
                continue
            final_name = unique_file_name(db, folder_id, original)
            stored_name = f"{uuid.uuid4().hex}.{ext}"
            target = UPLOAD_DIR / stored_name
            try:
                storage.save(target)
                size = target.stat().st_size
                if size <= 0:
                    target.unlink(missing_ok=True)
                    errors.append(f"{original}: 空文件")
                    continue
                cur = db.execute(
                    "INSERT INTO files (name, ext, size, stored_name, folder_id, created_by, created_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (final_name, ext, size, stored_name, folder_id, user_id, utcnow()),
                )
                db.commit()
                saved.append({"id": cur.lastrowid, "name": final_name, "size": size})
            except Exception as exc:  # pragma: no cover - defensive
                target.unlink(missing_ok=True)
                db.rollback()
                errors.append(f"{original}: {exc}")
        status = 200 if saved else 400
        return jsonify(ok=bool(saved), uploaded=saved, errors=errors), status

    @app.post("/api/rename")
    @admin_required
    def api_rename():
        require_csrf()
        payload = request.get_json(silent=True) or {}
        kind = payload.get("type")
        item_id = payload.get("id")
        name = clean_name(payload.get("name") or "", fallback="")
        if kind not in ("file", "folder") or not item_id or not name:
            return jsonify(ok=False, error="参数不完整。"), 400
        db = get_db()
        table = "files" if kind == "file" else "folders"
        row = db.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            return jsonify(ok=False, error="项目不存在。"), 404
        if kind == "file":
            _, ext = split_ext(name)
            if ext.lower() not in ALLOWED_EXTS:
                return jsonify(ok=False, error="文件扩展名不受支持。"), 400
        parent_col = "folder_id" if kind == "file" else "parent_id"
        parent = row[parent_col]
        clash = db.execute(
            f"SELECT 1 FROM {table} WHERE {parent_col} IS ? AND name = ? AND id != ?",
            (parent, name, item_id),
        ).fetchone()
        if clash:
            return jsonify(ok=False, error="同名项目已存在。"), 409
        db.execute(f"UPDATE {table} SET name = ? WHERE id = ?", (name, item_id))
        db.commit()
        return jsonify(ok=True, name=name)

    @app.post("/api/delete")
    @admin_required
    def api_delete():
        require_csrf()
        payload = request.get_json(silent=True) or {}
        kind = payload.get("type")
        item_id = payload.get("id")
        if kind not in ("file", "folder") or not item_id:
            return jsonify(ok=False, error="参数不完整。"), 400
        db = get_db()
        if kind == "file":
            row = db.execute("SELECT * FROM files WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                return jsonify(ok=False, error="文件不存在。"), 404
            db.execute("DELETE FROM files WHERE id = ?", (item_id,))
            db.commit()
            (UPLOAD_DIR / row["stored_name"]).unlink(missing_ok=True)
            return jsonify(ok=True)
        row = db.execute("SELECT * FROM folders WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            return jsonify(ok=False, error="文件夹不存在。"), 404

        to_delete: list[str] = []

        def walk(fid: int) -> None:
            for f in db.execute("SELECT stored_name FROM files WHERE folder_id = ?", (fid,)):
                to_delete.append(f["stored_name"])
            for sub in db.execute("SELECT id FROM folders WHERE parent_id = ?", (fid,)):
                walk(sub["id"])

        walk(item_id)
        db.execute("DELETE FROM folders WHERE id = ?", (item_id,))
        db.commit()
        for stored in to_delete:
            (UPLOAD_DIR / stored).unlink(missing_ok=True)
        return jsonify(ok=True)

    @app.get("/api/storage")
    def api_storage():
        row = get_db().execute(
            "SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM files"
        ).fetchone()
        return jsonify(ok=True, files=row["files"], bytes=row["bytes"])

    @app.get("/health")
    def health():
        return jsonify(ok=True, app="mccloud", files=int(
            get_db().execute("SELECT COUNT(*) FROM files").fetchone()[0]
        ))

    return app


app = create_app()


if __name__ == "__main__":
    app.run(
        host=os.environ.get("MCCLOUD_HOST", "127.0.0.1"),
        port=int(os.environ.get("MCCLOUD_PORT", "5000")),
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )
