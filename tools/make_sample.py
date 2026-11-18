"""Generate a small demo .schematic (MCEdit / WorldEdit classic NBT)."""

from __future__ import annotations

import gzip
import struct
from pathlib import Path

W, H, L = 48, 28, 48
blocks = [[[0 for _ in range(W)] for _ in range(L)] for _ in range(H)]

STONE = 1
GRASS = 2
COBBLE = 4
PLANKS = 5
WATER = 8
LOG = 17
LEAVES = 18
GLASS = 20
BRICKS = 45
STONE_BRICKS = 98
QUARTZ = 155
GLOWSTONE = 89
WOOL_RED = 35


def put(x: int, y: int, z: int, block: int) -> None:
    if 0 <= x < W and 0 <= y < H and 0 <= z < L:
        blocks[y][z][x] = block


# foundation + lawn
for z in range(L):
    for x in range(W):
        put(x, 0, z, STONE)
        put(x, 1, z, GRASS)

# outer walls with crenellations
for x in range(6, W - 6):
    for y in range(2, 10):
        put(x, y, 6, STONE_BRICKS)
        put(x, y, L - 7, STONE_BRICKS)
for z in range(7, L - 7):
    for y in range(2, 10):
        put(6, y, z, STONE_BRICKS)
        put(W - 7, y, z, STONE_BRICKS)

# wall caps
for x in range(6, W - 6):
    for z in (6, L - 7):
        put(x, 10, z, QUARTZ)
    for z in (6, L - 7):
        for x2 in range(x, x + 1):
            if (x2 + z) % 3 == 0:
                put(x2, 11, z, QUARTZ)
for z in range(7, L - 7):
    for x in (6, W - 7):
        put(x, 10, z, QUARTZ)

# corner towers
for cx, cz in ((6, 6), (W - 7, 6), (6, L - 7), (W - 7, L - 7)):
    for ox in range(-2, 3):
        for oz in range(-2, 3):
            if abs(ox) + abs(oz) > 3:
                continue
            for y in range(1, 16):
                put(cx + ox, y, cz + oz, COBBLE if y % 4 == 0 else STONE_BRICKS)
    for ox in range(-2, 3):
        for oz in range(-2, 3):
            if abs(ox) + abs(oz) <= 3:
                put(cx + ox, 16, cz + oz, QUARTZ)
    # conical roof
    for level in range(1, 4):
        span = 3 - level
        for ox in range(-span, span + 1):
            for oz in range(-span, span + 1):
                if abs(ox) + abs(oz) <= span:
                    put(cx + ox, 15 + level, cz + oz, BRICKS)

# gate
for z in range(6, 9):
    for y in range(2, 7):
        put(W // 2, y, z, 0)
        put(W // 2 - 1, y, z, 0)
put(W // 2 - 1, 7, 6, QUARTZ)
put(W // 2, 7, 6, QUARTZ)

# keep in the center
KX, KZ = W // 2 - 7, L // 2 - 7
for x in range(KX, KX + 15):
    for z in range(KZ, KZ + 15):
        for y in range(2, 17):
            edge = x in (KX, KX + 14) or z in (KZ, KZ + 14)
            if edge:
                put(x, y, z, QUARTZ if y % 6 == 0 else STONE_BRICKS)
        put(x, 17, z, QUARTZ)
# keep windows
for y in (6, 11, 14):
    for x in range(KX + 3, KX + 12, 3):
        put(x, y, KZ, GLASS)
        put(x, y, KZ + 14, GLASS)
    for z in range(KZ + 3, KZ + 12, 3):
        put(KX, y, z, GLASS)
        put(KX + 14, y, z, GLASS)
# keep roof
for level in range(0, 7):
    span = 7 - level
    for x in range(KX - 1 + level, KX + 15 - level):
        for z in range(KZ - 1 + level, KZ + 15 - level):
            put(x, 18 + level, z, BRICKS if level % 2 else QUARTZ)
put(W // 2, 25, L // 2, GLOWSTONE)
put(W // 2 - 1, 25, L // 2, GLOWSTONE)
put(W // 2, 25, L // 2 - 1, GLOWSTONE)

# paths + fountain
for z in range(10, L - 10):
    put(W // 2, 1, z, COBBLE)
    put(W // 2 - 1, 1, z, COBBLE)
for x in range(10, W - 10):
    put(x, 1, L // 2, COBBLE)
for ox in range(-3, 4):
    for oz in range(-3, 4):
        if abs(ox) + abs(oz) <= 3:
            put(W // 2 - 9 + ox, 1, L // 2 + 9 + oz, STONE)
            put(W // 2 - 9 + ox, 2, L // 2 + 9 + oz, WATER)
for ox, oz in ((-4, 0), (4, 0), (0, -4), (0, 4)):
    put(W // 2 - 9 + ox, 2, L // 2 + 9 + oz, QUARTZ)
put(W // 2 - 9, 3, L // 2 + 9, GLOWSTONE)

# little trees in the courtyard
for tx, tz in ((14, 14), (W - 15, 14), (14, L - 15), (W - 15, L - 15)):
    for y in range(2, 7):
        put(tx, y, tz, LOG)
    for ox in range(-2, 3):
        for oz in range(-2, 3):
            for oy in range(0, 3):
                if abs(ox) + abs(oz) + oy <= 3:
                    put(tx + ox, 6 + oy, tz + oz, LEAVES)

# banners of red wool over the gate
for y in range(8, 12):
    put(W // 2 - 3, y, 6, WOOL_RED)
    put(W // 2 + 2, y, 6, WOOL_RED)


def tag_byte(name: str, value: int) -> bytes:
    return b"\x01" + enc(name) + struct.pack(">b", value)


def tag_short(name: str, value: int) -> bytes:
    return b"\x02" + enc(name) + struct.pack(">h", value)


def tag_int(name: str, value: int) -> bytes:
    return b"\x03" + enc(name) + struct.pack(">i", value)


def tag_string(name: str, value: str) -> bytes:
    return b"\x08" + enc(name) + enc(value)


def tag_byte_array(name: str, value: bytes) -> bytes:
    return b"\x07" + enc(name) + struct.pack(">i", len(value)) + value


def tag_empty_list(name: str, element_type: int = 10) -> bytes:
    return b"\x09" + enc(name) + bytes([element_type]) + struct.pack(">i", 0)


def enc(value: str) -> bytes:
    raw = value.encode("utf-8")
    return struct.pack(">H", len(raw)) + raw


def compound(items: list[bytes]) -> bytes:
    return b"".join(items) + b"\x00"


width, height, length = W, H, L
flat = bytearray()
for y in range(height):
    for z in range(length):
        for x in range(width):
            flat.append(blocks[y][z][x])

root = compound(
    [
        tag_short("Width", width),
        tag_short("Height", height),
        tag_short("Length", length),
        tag_string("Materials", "Alpha"),
        tag_byte_array("Blocks", bytes(flat)),
        tag_byte_array("Data", bytes(width * height * length)),
        tag_empty_list("Entities"),
        tag_empty_list("TileEntities"),
    ]
)
payload = b"\x0a" + enc("") + root

out = Path(__file__).resolve().parent.parent / "data" / "samples" / "示例-石英城堡.schematic"
out.parent.mkdir(parents=True, exist_ok=True)
with gzip.open(out, "wb") as handle:
    handle.write(payload)
print(out, out.stat().st_size, "bytes")
