"""Live-wire (magnetic lasso) cost map — Mortensen–Barrett 1995.

Per-pixel cost field from Sobel gradient magnitude (+ Laplacian zero-crossing emphasis):
high gradient ⇒ LOW cost, so the shortest path snaps to edges. The frontend worker runs
Dijkstra over this field. Cached per image; downscaled for very large images (the frontend
maps seeds through `scale`).

Photoshop-style options:
- `contrast`  → edge sensitivity (gamma on the gradient; higher = only strong edges cheap).
- `width`     → search neighborhood, handled frontend-side (bounds the Dijkstra window).
"""
from __future__ import annotations

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore


def cost_map(rgb: np.ndarray, contrast: float = 1.0, downscale_max: int = 1600):
    """Return (cost_uint8 HxW, scale) where cost 0 = strongest edge (cheapest)."""
    assert cv2 is not None, "OpenCV required for live-wire"
    h, w = rgb.shape[:2]
    scale = 1.0
    img = rgb
    longest = max(h, w)
    if longest > downscale_max:
        scale = downscale_max / longest
        img = cv2.resize(rgb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    mag /= mag.max() + 1e-6

    # Laplacian zero-crossings sharpen the edge localization.
    lap = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
    zc = (np.abs(lap) < (0.02 * (np.abs(lap).max() + 1e-6))).astype(np.float32)
    feat = np.clip(mag + 0.25 * zc * mag, 0, 1)

    # contrast as gamma: >1 makes only strong edges cheap.
    feat = np.power(feat, max(0.1, contrast))
    cost = (1.0 - feat)  # high feature => low cost
    return (np.clip(cost, 0, 1) * 255).astype(np.uint8), scale
