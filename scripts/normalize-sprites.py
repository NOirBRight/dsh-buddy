#!/usr/bin/env python3
"""Normalize the sprite sheet into an exact 8x6 grid of 192x192 cells.

Detects the drawn grid separator lines (slightly darker than the background),
extracts each cell interior, and pastes it centered on a uniform background.
Writes page/buddy-sprites.png without creating an additional source artifact.
Set DSH_BUDDY_SPRITES_SOURCE to read a separate source image; the source must not resolve to the destination.
The destination must be a regular file when it already exists; symlink destinations are rejected.
"""
import os
import stat
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "page" / "buddy-sprites.png"
source_value = os.environ.get("DSH_BUDDY_SPRITES_SOURCE", "").strip()
if not source_value:
    raise FileNotFoundError("DSH_BUDDY_SPRITES_SOURCE must name the source artwork; refusing to read generated output")
SRC = Path(source_value)
if not SRC.is_absolute():
    SRC = ROOT / SRC
COLS, ROWS = 8, 6
CELL = 192

try:
    destination_metadata = DST.lstat()
except FileNotFoundError:
    destination_metadata = None
if destination_metadata is not None and stat.S_ISLNK(destination_metadata.st_mode):
    raise RuntimeError(f"sprite destination must not be a symlink: {DST}")
if os.path.normcase(os.path.realpath(SRC)) == os.path.normcase(os.path.realpath(DST)):
    raise ValueError(f"sprite source must not resolve to generated destination: {SRC}")
if not SRC.is_file():
    raise FileNotFoundError(f"sprite source does not exist: {SRC}")
try:
    if os.path.samefile(SRC, DST):
        raise ValueError(f"sprite source and destination must not be the same file: {SRC}")
except FileNotFoundError:
    # The destination may not exist before the first generated sheet.
    pass

im = Image.open(SRC).convert("RGB")
a = np.asarray(im).astype(np.int16)
h, w, _ = a.shape

bg = np.median(a[30:80, 30:80].reshape(-1, 3), axis=0)  # dark navy


def cells_along(med: np.ndarray, size: int, min_cell: int) -> list[tuple[int, int]]:
    """Split an axis into cells using dark separator-line runs."""
    bright = med.sum(axis=1)
    is_line = bright < bg.sum() - 3
    runs: list[list[int]] = []
    i = 0
    while i < size:
        if is_line[i]:
            j = i
            while j < size and is_line[j]:
                j += 1
            if runs and i - runs[-1][1] < 8:
                runs[-1][1] = j  # merge nearby runs
            else:
                runs.append([i, j])
            i = j
        else:
            i += 1
    # Boundaries: edges of the sheet plus every separator run.
    marks = [[0, 0]] + runs + [[size, size]]
    cells = []
    for k in range(len(marks) - 1):
        lo, hi = marks[k][1], marks[k + 1][0]
        if hi - lo >= min_cell:
            cells.append((lo, hi))
    return cells


col_cells = cells_along(np.median(a, axis=0), w, min_cell=120)
row_cells = cells_along(np.median(a, axis=1), h, min_cell=100)
print("cols:", len(col_cells), col_cells)
print("rows:", len(row_cells), row_cells)
if len(col_cells) != COLS or len(row_cells) != ROWS:
    raise ValueError("grid detection failed")

out = Image.new("RGBA", (COLS * CELL, ROWS * CELL), (0, 0, 0, 0))
bg_arr = bg.reshape(1, 1, 3)


def edge_connected_bg(cell: np.ndarray) -> np.ndarray:
    """Mask of near-background pixels reachable from the cell border.

    Keeps dark sprite outlines (enclosed by the body) opaque while making the
    surrounding background transparent.
    """
    line_color = np.array([30, 50, 86]).reshape(1, 1, 3)  # bluish grid stroke
    near_bg = (np.abs(cell - bg_arr).sum(axis=2) <= 40) | (np.abs(cell - line_color).sum(axis=2) <= 55)
    reach = np.zeros_like(near_bg)
    reach[0, :] = near_bg[0, :]
    reach[-1, :] = near_bg[-1, :]
    reach[:, 0] = near_bg[:, 0]
    reach[:, -1] = near_bg[:, -1]
    while True:
        grown = reach.copy()
        grown[1:, :] |= reach[:-1, :]
        grown[:-1, :] |= reach[1:, :]
        grown[:, 1:] |= reach[:, :-1]
        grown[:, :-1] |= reach[:, 1:]
        grown &= near_bg
        if (grown == reach).all():
            return reach
        reach = grown


for r, (y0, y1) in enumerate(row_cells):
    for c, (x0, x1) in enumerate(col_cells):
        cell = a[y0 + 2 : y1 - 2, x0 + 2 : x1 - 2]
        alpha = np.where(edge_connected_bg(cell), 0, 255).astype(np.uint8)
        ys, xs = np.nonzero(alpha)
        if len(ys) == 0:
            continue
        pad = 4
        ty0 = max(0, ys.min() - pad)
        ty1 = min(cell.shape[0], ys.max() + 1 + pad)
        tx0 = max(0, xs.min() - pad)
        tx1 = min(cell.shape[1], xs.max() + 1 + pad)
        rgba = np.dstack([cell, alpha]).astype(np.uint8)
        crop = Image.fromarray(rgba[ty0:ty1, tx0:tx1], "RGBA")
        cw, ch = crop.size
        scale = min((CELL - 12) / cw, (CELL - 12) / ch, 1.0)
        if scale < 1.0:
            crop = crop.resize((round(cw * scale), round(ch * scale)), Image.NEAREST)
            cw, ch = crop.size
        out.paste(crop, (c * CELL + (CELL - cw) // 2, r * CELL + (CELL - ch) // 2))

# Recolor: shift the whale's teal hue (~175°) toward DeepSeek blue, but keep
# it soft and cute — lower saturation, higher lightness (≈ cornflower #7590F0).
rgba = np.asarray(out).astype(np.float32)
rgb = rgba[..., :3] / 255.0
mx = rgb.max(axis=2)
mn = rgb.min(axis=2)
delta = mx - mn
sat = np.where(mx > 0, delta / np.maximum(mx, 1e-6), 0)
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
hue = np.zeros_like(mx)
nz = delta > 1e-6
rmax = nz & (mx == r)
gmax = nz & (mx == g) & ~rmax
bmax = nz & ~rmax & ~gmax
hue[rmax] = (60 * ((g - b)[rmax] / delta[rmax])) % 360
hue[gmax] = 60 * ((b - r)[gmax] / delta[gmax]) + 120
hue[bmax] = 60 * ((r - g)[bmax] / delta[bmax]) + 240

teal = (hue >= 140) & (hue <= 205) & (sat > 0.18) & (rgba[..., 3] > 0)
hue2 = np.where(teal, (hue + 50) % 360, hue)
sat2 = np.where(teal, np.clip(sat * 0.70, 0, 1), sat)
val2 = np.where(teal, np.clip(mx * 1.30, 0, 1), mx)

h60 = hue2 / 60.0
i = np.floor(h60).astype(int) % 6
f = h60 - np.floor(h60)
p = val2 * (1 - sat2)
q = val2 * (1 - sat2 * f)
t = val2 * (1 - sat2 * (1 - f))
r2 = np.choose(i, [val2, q, p, p, t, val2])
g2 = np.choose(i, [t, val2, val2, q, p, p])
b2 = np.choose(i, [p, p, t, val2, val2, q])
rgba[..., 0] = r2 * 255
rgba[..., 1] = g2 * 255
rgba[..., 2] = b2 * 255
out = Image.fromarray(rgba.astype(np.uint8))

temporary_path = None
try:
    with tempfile.NamedTemporaryFile(dir=DST.parent, prefix=DST.name + ".", suffix=".tmp", delete=False) as temporary:
        temporary_path = temporary.name
    out.save(temporary_path, format="PNG")
    os.replace(temporary_path, DST)
    temporary_path = None
finally:
    if temporary_path is not None:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            # A failed atomic write may already have removed the temporary file.
            pass
print("wrote", DST, out.size)
