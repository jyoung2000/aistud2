"""Shared image session + PNG/base64 helpers.

A single active image session holds the loaded RGB image (image space) for SAM 2 encoding,
selection, matting, and crop-composite. Single-session is fine for a desktop app.
"""
from __future__ import annotations

import base64
import io
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from PIL import Image


def png_to_base64(arr: np.ndarray, mode: str = "L") -> str:
    """Encode a uint8 array (H,W) or (H,W,C) as base64 PNG (no data: prefix)."""
    img = Image.fromarray(arr, mode)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def base64_to_gray(data: str) -> np.ndarray:
    """Decode a base64 PNG (data URL or raw) into a uint8 (H,W) array."""
    if "," in data and data.strip().startswith("data:"):
        data = data.split(",", 1)[1]
    raw = base64.b64decode(data)
    img = Image.open(io.BytesIO(raw)).convert("L")
    return np.asarray(img, dtype=np.uint8)


def load_rgb(raw: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    return np.asarray(img, dtype=np.uint8)


@dataclass
class ImageSession:
    image_id: str
    rgb: np.ndarray  # (H, W, 3) uint8
    extra: dict = field(default_factory=dict)

    @property
    def width(self) -> int:
        return int(self.rgb.shape[1])

    @property
    def height(self) -> int:
        return int(self.rgb.shape[0])


_active: Optional[ImageSession] = None


def set_active(session: ImageSession) -> None:
    global _active
    _active = session


def active() -> Optional[ImageSession]:
    return _active


def require_active(image_id: Optional[str] = None) -> ImageSession:
    s = _active
    if s is None:
        raise KeyError("no image loaded — call /load first")
    if image_id is not None and image_id != s.image_id:
        raise KeyError(f"image {image_id} is not the active session")
    return s
