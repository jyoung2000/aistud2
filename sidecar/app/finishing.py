"""Finishing pass — upscale + face restore. Real-ESRGAN / GFPGAN / CodeFormer on the target
GPU (VRAM-aware tiling); a tiled Lanczos upscale + unsharp 'restore' fallback so it runs
anywhere. Since edits happen on crops, this is what brings final output quality up.
"""
from __future__ import annotations

import os

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore


def _tiled_resize(rgb: np.ndarray, scale: int, tile: int = 1024) -> np.ndarray:
    """Lanczos upscale, tiled so huge images don't blow memory."""
    h, w = rgb.shape[:2]
    out = np.empty((h * scale, w * scale, 3), np.uint8)
    for y0 in range(0, h, tile):
        for x0 in range(0, w, tile):
            y1, x1 = min(h, y0 + tile), min(w, x0 + tile)
            t = cv2.resize(rgb[y0:y1, x0:x1], ((x1 - x0) * scale, (y1 - y0) * scale), interpolation=cv2.INTER_LANCZOS4)
            out[y0 * scale : y1 * scale, x0 * scale : x1 * scale] = t
    return out


def upscale(rgb: np.ndarray, scale: int) -> tuple[np.ndarray, str]:
    scale = 4 if scale >= 4 else 2
    model = os.environ.get("NEUCLIP_REALESRGAN_MODEL")
    if model:
        try:  # pragma: no cover - heavy GPU dep
            from realesrgan import RealESRGANer  # type: ignore  # noqa

            raise NotImplementedError("wire Real-ESRGAN weights on the target GPU")
        except Exception as e:
            print(f"[finish] Real-ESRGAN unavailable, Lanczos fallback: {e}")
    assert cv2 is not None
    return _tiled_resize(rgb, scale), "lanczos"


def restore_faces(rgb: np.ndarray, strength: float) -> tuple[np.ndarray, str]:
    model = os.environ.get("NEUCLIP_GFPGAN_MODEL")
    if model:
        try:  # pragma: no cover
            from gfpgan import GFPGANer  # type: ignore  # noqa

            raise NotImplementedError("wire GFPGAN/CodeFormer weights on the target GPU")
        except Exception as e:
            print(f"[finish] GFPGAN unavailable, detail-enhance fallback: {e}")
    if cv2 is None:
        return rgb, "none"
    # fallback: gentle unsharp (a stand-in for real face restoration)
    s = max(0.0, min(1.0, strength))
    blur = cv2.GaussianBlur(rgb, (0, 0), 1.0)
    sharp = cv2.addWeighted(rgb.astype(np.float32), 1 + s, blur.astype(np.float32), -s, 0)
    return np.clip(sharp, 0, 255).astype(np.uint8), "unsharp"
