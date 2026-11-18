#!/usr/bin/env python3
"""One-click remote deployment helper for 方块云盘.

Usually started by deploy.bat. It packages the app (with a consistent SQLite
snapshot), uploads it over SFTP, builds a Docker image on the server, starts a
container on port 25560, and verifies /health.

Usage:
    python tools/deploy_server.py
    python tools/deploy_server.py --reset-data
    set DEPLOY_SSH_PASSWORD=...  (optional, otherwise prompts securely)
"""

from __future__ import annotations

import argparse
import getpass
import os
import shutil
import sqlite3
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

try:
    import paramiko
except ImportError:
    print("缺少 paramiko，请先运行：python -m pip install paramiko")
    raise SystemExit(1)

BASE_DIR = Path(__file__).resolve().parent.parent
HOST = os.environ.get("DEPLOY_HOST", "mcbe.l.cd")
SSH_PORT = int(os.environ.get("DEPLOY_SSH_PORT", "22"))
SSH_USER = os.environ.get("DEPLOY_USER", "root")
APP_PORT = int(os.environ.get("DEPLOY_PORT", "25560"))
INTERNAL_PORT = int(os.environ.get("DEPLOY_INTERNAL_PORT", "25561"))
REMOTE_DIR = os.environ.get("DEPLOY_REMOTE_DIR", "/opt/mccloud")
CONTAINER = os.environ.get("DEPLOY_CONTAINER", "mccloud")
IMAGE = os.environ.get("DEPLOY_IMAGE", "mccloud:latest")


def log(message: str) -> None:
    print(message, flush=True)


def make_archive() -> Path:
    """Create a tar.gz containing code plus a consistent data snapshot."""
    tmp = Path(tempfile.mkdtemp(prefix="mccloud-deploy-"))
    root = tmp / "mccloud"
    root.mkdir(parents=True)

    for name in ("app.py", "requirements.txt", "README.md", "Dockerfile", ".dockerignore"):
        src = BASE_DIR / name
        if not src.exists():
            raise FileNotFoundError(f"缺少必要文件：{src}")
        shutil.copy2(src, root / name)

    for name in ("templates", "static"):
        shutil.copytree(BASE_DIR / name, root / name)

    tools = root / "tools"
    tools.mkdir()
    if (BASE_DIR / "tools" / "make_sample.py").exists():
        shutil.copy2(BASE_DIR / "tools" / "make_sample.py", tools / "make_sample.py")

    data_src = BASE_DIR / "data"
    data_dst = root / "data"
    data_dst.mkdir()
    # Snapshot SQLite safely even if the local dev server is running.
    if (data_src / "mccloud.db").exists():
        src = sqlite3.connect(data_src / "mccloud.db")
        dst = sqlite3.connect(data_dst / "mccloud.db")
        src.backup(dst)
        dst.close()
        src.close()
    for name in ("secret_key", "samples"):
        source = data_src / name
        if source.exists():
            if source.is_dir():
                shutil.copytree(source, data_dst / name)
            else:
                shutil.copy2(source, data_dst / name)
    if (data_src / "files").is_dir():
        shutil.copytree(data_src / "files", data_dst / "files")

    archive = tmp / "mccloud-deploy.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        tf.add(root, arcname="mccloud")

    if (data_dst / "mccloud.db").exists():
        db = sqlite3.connect(data_dst / "mccloud.db")
        files = db.execute("SELECT COUNT(*) FROM files").fetchone()[0]
        db.close()
    else:
        files = 0
    log(f"本地打包完成：{archive} ({archive.stat().st_size / 1024 / 1024:.1f} MB，{files} 个文件)")
    return archive


REMOTE_SCRIPT = r"""#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /tmp/mccloud-deploy.log) 2>&1
APP_DIR="__APP_DIR__"
ARCHIVE="/tmp/mccloud-deploy.tar.gz"
WORK="/tmp/mccloud-extract"
PUBLIC_PORT="__APP_PORT__"
INTERNAL_PORT="__INTERNAL_PORT__"
CONTAINER="__CONTAINER__"
IMAGE="__IMAGE__"
RESET_DATA="${DEPLOY_RESET_DATA:-0}"

finish() {
  rc=$?
  echo "$rc" > /tmp/mccloud-deploy.exit
  echo "===== deploy exit=$rc ====="
  exit "$rc"
}
trap finish EXIT

echo "===== 1. 检查环境 ====="
docker --version
command -v tar >/dev/null
mkdir -p "$APP_DIR"

echo "===== 2. 备份旧静态站 ====="
if [ -d /root/blockdrive ]; then
  BK=$(ls /root/blockdrive-backup-*.tar.gz 2>/dev/null | tail -1 || true)
  if [ -z "$BK" ]; then
    tar -czf /root/blockdrive-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C /root blockdrive
  fi
fi

echo "===== 3. 解压新版本 ====="
rm -rf "$WORK"
mkdir -p "$WORK"
tar -xzf "$ARCHIVE" -C "$WORK"
NEW="$WORK/mccloud"

echo "===== 4. 更新代码（保留服务器 data） ====="
if [ -f "$APP_DIR/app.py" ]; then
  tar -czf /tmp/mccloud-code-before-$(date +%Y%m%d-%H%M%S).tar.gz \
    -C "$APP_DIR" --exclude=data . 2>/dev/null || true
fi
for f in app.py requirements.txt Dockerfile .dockerignore README.md; do
  cp -f "$NEW/$f" "$APP_DIR/$f"
done
rm -rf "$APP_DIR/templates" "$APP_DIR/static" "$APP_DIR/tools"
cp -a "$NEW/templates" "$APP_DIR/templates"
cp -a "$NEW/static" "$APP_DIR/static"
cp -a "$NEW/tools" "$APP_DIR/tools"

mkdir -p "$APP_DIR/data"
if [ ! -f "$APP_DIR/data/mccloud.db" ] || [ "$RESET_DATA" = "1" ]; then
  echo "安装本地 data 快照（首次部署或 --reset-data）"
  rm -rf "$APP_DIR/data/files" "$APP_DIR/data/samples"
  cp -a "$NEW/data/." "$APP_DIR/data/"
else
  echo "检测到服务器已有 data，保留服务器数据"
fi
mkdir -p "$APP_DIR/data/files"

echo "===== 5. 停止旧服务 ====="
docker rm -f "$CONTAINER" 2>/dev/null || true
if ss -ltnp 2>/dev/null | grep -q ":$INTERNAL_PORT "; then
  echo "错误：内部端口 $INTERNAL_PORT 仍被占用："
  ss -ltnp | grep ":$INTERNAL_PORT " || true
  exit 2
fi
sleep 1

echo "===== 6. 构建镜像 ====="
cd "$APP_DIR"
docker build -t "$IMAGE" .

echo "===== 7. 启动容器 ====="
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "127.0.0.1:$INTERNAL_PORT:25560" \
  -v "$APP_DIR/data:/app/data" \
  -e TZ=Asia/Shanghai \
  --log-opt max-size=20m \
  --log-opt max-file=3 \
  "$IMAGE"

echo "===== 8. 等待健康检查 ====="
OK=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$INTERNAL_PORT/health"; then
    echo
    OK=1
    break
  fi
  sleep 2
done
if [ "$OK" != "1" ]; then
  echo "健康检查失败，容器日志："
  docker logs --tail 100 "$CONTAINER" 2>&1 || true
  exit 3
fi

echo "===== 9. 容器状态 ====="
docker ps --filter "name=$CONTAINER" --format '{{.Names}} {{.Status}} {{.Ports}}'
echo "部署完成：https://__HOST__:$PUBLIC_PORT"
"""


def connect(password: str):
    last = None
    for attempt in range(1, 6):
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                HOST,
                port=SSH_PORT,
                username=SSH_USER,
                password=password,
                timeout=30,
                banner_timeout=30,
                auth_timeout=30,
                look_for_keys=False,
                allow_agent=False,
            )
            client.get_transport().set_keepalive(20)
            return client
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < 5:
                log(f"SSH 连接失败（第 {attempt} 次），5 秒后重试：{exc}")
                time.sleep(5)
    raise RuntimeError(f"无法连接服务器：{last}")


def run(client, command: str, timeout: int = 60, stream: bool = False) -> tuple[int, str, str]:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if stream:
        if out.strip():
            print(out.rstrip())
        if err.strip():
            print(err.rstrip(), file=sys.stderr)
    return code, out, err


def upload(client, local: Path, remote: str) -> None:
    sftp = client.open_sftp()
    total = local.stat().st_size
    last = [0.0]

    def progress(done, _total):
        pct = done * 100.0 / max(total, 1)
        if pct - last[0] >= 10:
            last[0] = pct
            log(f"上传进度 {pct:.0f}%")

    log(f"上传 {local.name} 到 {HOST}:{remote} ...")
    sftp.put(str(local), remote, callback=progress)
    sftp.close()
    stat = None
    _, out, _ = run(client, f"stat -c %s {remote}")
    try:
        stat = int(out.strip())
    except ValueError:
        pass
    if stat != total:
        raise RuntimeError(f"上传文件大小不一致：本地 {total}，服务器 {stat}")
    log(f"上传完成（{total / 1024 / 1024:.1f} MB）")


def deploy(reset_data: bool, password: str) -> int:
    archive = make_archive()
    client = connect(password)
    try:
        code, out, _ = run(client, "uname -s; docker --version", stream=True)
        if code != 0:
            log("服务器缺少 Docker 或无法执行命令。")
            return 1

        upload(client, archive, "/tmp/mccloud-deploy.tar.gz")

        remote_script = (
            REMOTE_SCRIPT.replace("__APP_DIR__", REMOTE_DIR)
            .replace("__APP_PORT__", str(APP_PORT))
            .replace("__INTERNAL_PORT__", str(INTERNAL_PORT))
            .replace("__CONTAINER__", CONTAINER)
            .replace("__IMAGE__", IMAGE)
            .replace("__HOST__", HOST)
        )
        sftp = client.open_sftp()
        with sftp.file("/tmp/mccloud-deploy.sh", "w") as handle:
            handle.write(remote_script)
        sftp.chmod("/tmp/mccloud-deploy.sh", 0o755)
        sftp.close()

        reset_flag = "1" if reset_data else "0"
        run(client, "rm -f /tmp/mccloud-deploy.exit /tmp/mccloud-deploy.log")
        code, out, err = run(
            client,
            f"cd /tmp && DEPLOY_RESET_DATA={reset_flag} nohup bash /tmp/mccloud-deploy.sh "
            f">/tmp/mccloud-deploy.log 2>&1 & echo $!",
        )
        try:
            pid = int(out.strip().splitlines()[-1])
        except ValueError:
            log("无法取得远程部署进程 PID。")
            print(out, err)
            return 1
        log(f"远程部署已启动（PID {pid}），等待构建与启动……")

        deadline = time.time() + 15 * 60
        last_log = ""
        while time.time() < deadline:
            time.sleep(4)
            try:
                code, status, _ = run(
                    client,
                    "cat /tmp/mccloud-deploy.exit 2>/dev/null || true",
                )
                code, content, _ = run(
                    client,
                    "tail -n 30 /tmp/mccloud-deploy.log 2>/dev/null || true",
                )
                if content and content != last_log:
                    last_log = content
                    print(content.rstrip())
                if status.strip():
                    rc = int(status.strip())
                    log(f"远程部署退出码：{rc}")
                    if rc != 0:
                        log("部署失败，请查看上面的日志。")
                        return rc
                    break
                # If the process died without writing the exit file, fail.
                _, alive, _ = run(client, f"kill -0 {pid} 2>/dev/null && echo yes || echo no")
                if alive.strip() == "no":
                    log("远程部署进程已退出，但没有生成退出码文件。")
                    return 1
            except Exception as exc:  # noqa: BLE001
                log(f"读取部署状态失败（将重试）：{exc}")
                try:
                    client.close()
                except Exception:
                    pass
                client = connect(password)
        else:
            log("部署超时（15 分钟）。")
            return 1

        # Verify from the local machine as well.
        url = f"https://{HOST}:{APP_PORT}/health"
        for attempt in range(6):
            try:
                with urllib.request.urlopen(url, timeout=10) as response:
                    body = response.read().decode("utf-8", "replace")
                log(f"公网健康检查通过：{url} -> {body}")
                break
            except Exception as exc:  # noqa: BLE001
                if attempt == 5:
                    log(f"本机访问 {url} 失败：{exc}")
                    return 1
                time.sleep(3)

        log("")
        log("=" * 58)
        log(f"部署成功：https://{HOST}:{APP_PORT}")
        log("管理员账号：沿用 data 中现有配置（全新安装默认 admin / admin123）")
        log("登录后点右上角齿轮可修改账号密码。")
        log("=" * 58)
        return 0
    finally:
        try:
            client.close()
        except Exception:
            pass


def main() -> int:
    global HOST, APP_PORT, SSH_USER
    parser = argparse.ArgumentParser(description="部署方块云盘到远程 Docker 服务器")
    parser.add_argument("--reset-data", action="store_true", help="用本地 data 覆盖服务器 data（危险）")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=APP_PORT)
    parser.add_argument("--user", default=SSH_USER)
    args = parser.parse_args()

    HOST, APP_PORT, SSH_USER = args.host, args.port, args.user

    password = os.environ.get("DEPLOY_SSH_PASSWORD")
    if not password:
        password = getpass.getpass(f"{SSH_USER}@{HOST} 的 SSH 密码：")
    if not password:
        log("密码不能为空。")
        return 1

    log(f"目标：{SSH_USER}@{HOST}:{SSH_PORT}，应用端口 {APP_PORT}")
    return deploy(args.reset_data, password)


if __name__ == "__main__":
    sys.exit(main())
