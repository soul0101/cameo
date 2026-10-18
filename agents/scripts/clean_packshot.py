"""Make a generated packshot read like the starter photos: background lifted to pure white, cropped to the product.

    .venv/bin/python scripts/clean_packshot.py ../web/public/brands/brewno-in.jpg [...]

The catalog melts white backgrounds into its grey well (mix-blend multiply); a grey studio gradient or a small
product leaves a visible inner square. Background = the median of the image border; every pixel is scaled so that
colour becomes white; the crop is the bounding box of pixels clearly darker than white, plus a 7% margin, squared.
"""

import subprocess
import sys
from pathlib import Path

import numpy as np


def load(p: Path) -> np.ndarray:
    w, h = (int(x) for x in subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(p)], capture_output=True, text=True, check=True).stdout.strip().split(","))
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, 3).astype(np.float32)


def save(a: np.ndarray, p: Path) -> None:
    h, w, _ = a.shape
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "-", "-q:v", "3", str(p)], input=a.astype(np.uint8).tobytes(), check=True)


def clean(p: Path) -> None:
    a = load(p)
    border = np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3), a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    # per-channel gain so the backdrop becomes white; a gradient backdrop is handled by a row-wise estimate
    rows = np.median(np.concatenate([a[:, :12], a[:, -12:]], axis=1), axis=1)  # (h, 3) backdrop down the image
    gain = 255.0 / np.clip(rows, 1, 255)[:, None, :]
    out = np.clip(a * gain, 0, 255)
    ink = (out.min(axis=2) < 235)
    ys, xs = np.where(ink)
    if len(ys):
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        side = int(max(y1 - y0, x1 - x0) * 1.14)
        cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
        canvas = np.full((side, side, 3), 255, np.float32)
        sy, sx = cy - side // 2, cx - side // 2
        ys0, xs0 = max(sy, 0), max(sx, 0)
        ys1, xs1 = min(sy + side, out.shape[0]), min(sx + side, out.shape[1])
        canvas[ys0 - sy:ys1 - sy, xs0 - sx:xs1 - sx] = out[ys0:ys1, xs0:xs1]
        out = canvas
    save(out, p)
    print(f"{p.name}: backdrop {bg.round().astype(int).tolist()} -> white, {out.shape[1]}x{out.shape[0]}")


if __name__ == "__main__":
    for f in sys.argv[1:]:
        clean(Path(f))
