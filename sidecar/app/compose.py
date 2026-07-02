"""Crop-only send + feathered composite-back (contract #3).

Generation ALWAYS operates on a padded crop of the selection bbox, never the full frame.
The result is composited back through a feathered alpha so the seam is invisible and every
pixel the user did NOT select stays byte-for-byte identical (alpha==0 ⇒ untouched).
"""
from __future__ import annotations

from typing import Optional, Tuple

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore

Region = Tuple[int, int, int, int]  # (x0, y0, x1, y1) inclusive


def mask_bbox(mask: np.ndarray) -> Optional[Region]:
    ys, xs = np.where(mask > 0)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def crop_region(
    rgb: np.ndarray, mask: np.ndarray, pad_frac: float = 0.12
) -> Tuple[np.ndarray, np.ndarray, Region]:
    """Return (crop_rgb, crop_mask, region) for the padded selection bbox."""
    bb = mask_bbox(mask)
    if bb is None:
        raise ValueError("empty mask")
    x0, y0, x1, y1 = bb
    w, h = x1 - x0 + 1, y1 - y0 + 1
    px, py = int(round(w * pad_frac)), int(round(h * pad_frac))
    H, W = mask.shape[:2]
    X0, Y0 = max(0, x0 - px), max(0, y0 - py)
    X1, Y1 = min(W - 1, x1 + px), min(H - 1, y1 + py)
    region = (X0, Y0, X1, Y1)
    crop = rgb[Y0 : Y1 + 1, X0 : X1 + 1].copy()
    cmask = mask[Y0 : Y1 + 1, X0 : X1 + 1].copy()
    return crop, cmask, region


def feather_alpha(crop_mask: np.ndarray, radius: float = 2.5) -> np.ndarray:
    """Soft 0..1 alpha from a crop mask (Gaussian feather of the edge).

    The incoming mask may already be SOFT (client-side anti-aliasing / feather) — treat it
    as coverage, don't binarize, so a feathered selection survives the round trip."""
    a = crop_mask.astype(np.float32) / 255.0
    if cv2 is not None and radius > 0:
        a = cv2.GaussianBlur(a, (0, 0), radius)
    return np.clip(a, 0.0, 1.0)


def composite_back(
    rgb: np.ndarray, region: Region, result_crop: np.ndarray, alpha: np.ndarray
) -> np.ndarray:
    """Composite a result crop back through the feathered alpha.

    Pixels where alpha==0 — and everything outside `region` — are left byte-for-byte
    identical to the input.
    """
    out = rgb.copy()
    X0, Y0, X1, Y1 = region
    sub = out[Y0 : Y1 + 1, X0 : X1 + 1]
    rh, rw = sub.shape[:2]

    res = result_crop
    if res.shape[:2] != (rh, rw):
        if cv2 is None:
            raise RuntimeError("OpenCV required to resize a model result")
        res = cv2.resize(res, (rw, rh), interpolation=cv2.INTER_LANCZOS4)

    a = alpha[..., None]
    blended = res.astype(np.float32) * a + sub.astype(np.float32) * (1.0 - a)
    touched = alpha > 0  # only write feathered region; alpha==0 stays exact
    sub_out = sub.copy()
    sub_out[touched] = np.clip(np.round(blended[touched]), 0, 255).astype(np.uint8)
    out[Y0 : Y1 + 1, X0 : X1 + 1] = sub_out
    return out


def mock_edit(crop_rgb: np.ndarray, prompt: str, seed: int = 0) -> np.ndarray:
    """A deterministic local 'edit' so the full select→generate→composite loop works
    without a WaveSpeed key (used when mock=True or no API key). Warm/cool tint by prompt
    hash + seed so different prompts AND seeds visibly differ (for re-roll / variations)."""
    h = (((sum(ord(c) for c in prompt) if prompt else 0) + int(seed)) % 6)
    shift = np.array([[20, -10, -10], [ -10, 20, -10], [-10, -10, 20],
                      [20, 20, -20], [-20, 20, 20], [20, -20, 20]][h], np.float32)
    # seed also scales magnitude (30 distinct looks) so shootout tiles with per-model
    # seeds visibly differ even when the tint index collides mod 6.
    mag = 1.0 + (((int(seed) * 2654435761) >> 7) % 5) * 0.35
    out = np.clip(crop_rgb.astype(np.float32) + shift * mag, 0, 255).astype(np.uint8)
    return out
