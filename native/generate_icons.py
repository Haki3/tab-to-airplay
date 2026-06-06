#!/usr/bin/env python3
"""Generate the extension's PNG icons (no external deps), antialiased via supersampling.

Design: a rounded blue square with a clean AirPlay glyph (screen outline + upward triangle).
"""
import struct
import zlib
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "icons")
SS = 4  # supersampling factor for antialiasing

# Apple-ish blue gradient endpoints + white glyph
TOP = (10, 140, 255)
BOT = (0, 102, 224)
WHITE = (255, 255, 255)


def rounded_inside(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(px, py, ax, ay, bx, by, cx, cy):
    d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def color_at(px, py, s):
    """Return (r,g,b,a) at continuous point (px,py) on an s x s canvas."""
    R = 0.22 * s
    if not rounded_inside(px, py, 0.5, 0.5, s - 0.5, s - 0.5, R):
        return (0, 0, 0, 0)
    # vertical gradient background
    t = py / s
    bg = tuple(int(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3))

    # screen outline (rounded rect with a gap at the bottom-center for the triangle)
    sx0, sy0, sx1, sy1 = 0.20 * s, 0.20 * s, 0.80 * s, 0.585 * s
    stroke = 0.052 * s
    sr = 0.085 * s
    outer = rounded_inside(px, py, sx0, sy0, sx1, sy1, sr)
    inner = rounded_inside(px, py, sx0 + stroke, sy0 + stroke, sx1 - stroke, sy1 - stroke, max(1.0, sr - stroke))
    gap = (abs(px - s * 0.5) < 0.14 * s) and (py > sy1 - stroke * 1.5)  # open bottom-center
    if outer and not inner and not gap:
        return WHITE + (255,)

    # upward triangle
    ax, ay = 0.50 * s, 0.45 * s
    bx, by = 0.305 * s, 0.82 * s
    cx, cy = 0.695 * s, 0.82 * s
    if in_triangle(px, py, ax, ay, bx, by, cx, cy):
        return WHITE + (255,)

    return bg + (255,)


def make(size):
    buf = bytearray()
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS
                    py = y + (sy + 0.5) / SS
                    cr, cg, cb, ca = color_at(px, py, size)
                    # premultiply for correct edge blending
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    a += ca
            n = SS * SS
            if a == 0:
                buf.extend((0, 0, 0, 0))
            else:
                buf.extend((r // a, g // a, b // a, a // n))
    return bytes(buf)


def write_png(path, size, raw):
    stride = size * 4
    data = bytearray()
    for y in range(size):
        data.append(0)
        data.extend(raw[y * stride:(y + 1) * stride])
    comp = zlib.compress(bytes(data), 9)

    def chunk(typ, payload):
        return (struct.pack(">I", len(payload)) + typ + payload
                + struct.pack(">I", zlib.crc32(typ + payload) & 0xffffffff))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", comp)
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(os.path.join(OUT, "icon%d.png" % size), size, make(size))
        print("✓ icon%d.png" % size)


if __name__ == "__main__":
    main()
