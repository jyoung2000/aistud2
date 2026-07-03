"""Stage 3 — SelectionContext: what the app knows that the user didn't say.

Computed at /synthesize and /generate time from data already in the session: mask
geometry, scene statistics (the same LAB stats harmonize.py uses), and pipeline state.
Every field is optional and every path degrades gracefully on CPU / missing data —
context enriches prompts, it never blocks them.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore


@dataclass
class SelectionContext:
    # geometry
    area_frac: Optional[float] = None       # mask area / frame area
    position: Optional[str] = None          # "centered" | "left edge" | ...
    aspect: Optional[str] = None            # "tall" | "wide" | "squarish"
    small_object: bool = False              # < 3% of frame → known-failure mitigation
    edge_touching: bool = False             # selection touches the frame edge
    soft_mask: bool = False                 # feathered / fractional coverage present
    # content
    selection_desc: Optional[str] = None    # "a person's upper body, ~18% of frame, centered"
    selection_label: Optional[str] = None   # decompose label passed by the frontend
    likely_person: bool = False
    # scene
    scene_desc: Optional[str] = None        # "warm, dim scene with muted colors"
    scene_brightness: Optional[str] = None  # bright | dim | mid
    scene_temperature: Optional[str] = None # warm | cool | neutral
    scene_saturation: Optional[str] = None  # vivid | muted | mid
    # pipeline
    reference_role: Optional[str] = None
    lora_triggers: List[str] = field(default_factory=list)
    paradigm: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "area_frac": self.area_frac,
            "position": self.position,
            "aspect": self.aspect,
            "small_object": self.small_object,
            "edge_touching": self.edge_touching,
            "soft_mask": self.soft_mask,
            "selection_desc": self.selection_desc,
            "selection_label": self.selection_label,
            "likely_person": self.likely_person,
            "scene_desc": self.scene_desc,
            "reference_role": self.reference_role,
            "lora_triggers": self.lora_triggers,
            "paradigm": self.paradigm,
        }


def _skin_frac(rgb: np.ndarray, mask: np.ndarray) -> float:
    """Very rough skin-tone heuristic (RGB rule of Peer et al.) — CPU-cheap."""
    sel = mask > 0
    if not sel.any():
        return 0.0
    px = rgb[sel].astype(np.int16)
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    skin = (
        (r > 95) & (g > 40) & (b > 20)
        & ((px.max(axis=1) - px.min(axis=1)) > 15)
        & (np.abs(r - g) > 15) & (r > g) & (r > b)
    )
    return float(skin.mean())


def build_context(
    rgb: Optional[np.ndarray],
    mask: Optional[np.ndarray],
    *,
    selection_label: Optional[str] = None,
    reference_role: Optional[str] = None,
    lora_triggers: Optional[List[str]] = None,
    paradigm: Optional[str] = None,
) -> SelectionContext:
    ctx = SelectionContext(
        selection_label=selection_label,
        reference_role=reference_role,
        lora_triggers=list(lora_triggers or []),
        paradigm=paradigm,
    )
    if rgb is None or mask is None:
        return ctx
    H, W = mask.shape[:2]
    sel = mask > 0
    area = int(sel.sum())
    if area == 0:
        return ctx

    # --- geometry -------------------------------------------------------------
    ctx.area_frac = round(area / float(H * W), 4)
    ctx.small_object = ctx.area_frac < 0.03
    ys, xs = np.where(sel)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    ctx.aspect = "tall" if bh > 1.5 * bw else "wide" if bw > 1.5 * bh else "squarish"
    ctx.edge_touching = x0 <= 1 or y0 <= 1 or x1 >= W - 2 or y1 >= H - 2
    cx, cy = (x0 + x1) / 2 / W, (y0 + y1) / 2 / H
    horiz = "left" if cx < 1 / 3 else "right" if cx > 2 / 3 else "center"
    vert = "top" if cy < 1 / 3 else "bottom" if cy > 2 / 3 else "middle"
    ctx.position = "centered" if (horiz, vert) == ("center", "middle") else f"{vert} {horiz}".replace("middle ", "").replace(" center", "")
    inter = int(((mask > 10) & (mask < 245)).sum())
    ctx.soft_mask = inter > max(64, area // 50)

    # --- content (CPU heuristics; the decompose label wins when provided) ------
    ctx.likely_person = _skin_frac(rgb, mask) > 0.18
    label = selection_label
    if not label:
        if ctx.likely_person:
            label = "a person (or exposed skin)"
        else:
            label = "the selected object" if ctx.area_frac < 0.5 else "a large region of the image"
    size_word = (
        "a small part" if ctx.area_frac < 0.03 else
        f"~{round(ctx.area_frac * 100)}% of the frame"
    )
    ctx.selection_desc = f"{label}, {size_word}, {ctx.position}"

    # --- scene stats (same LAB machinery harmonize.py uses — effectively free) --
    try:
        if cv2 is not None:
            small = rgb[:: max(1, H // 256), :: max(1, W // 256)]
            lab = cv2.cvtColor(small, cv2.COLOR_RGB2LAB).astype(np.float32)
            L, A, B = lab[..., 0].mean(), lab[..., 1].mean() - 128, lab[..., 2].mean() - 128
            sat = float(np.hypot(lab[..., 1] - 128, lab[..., 2] - 128).mean())
        else:  # numpy-only fallback: luma + crude warmth from R-B
            small = rgb[:: max(1, H // 256), :: max(1, W // 256)].astype(np.float32)
            L = (0.299 * small[..., 0] + 0.587 * small[..., 1] + 0.114 * small[..., 2]).mean() / 255 * 255
            B = float((small[..., 0] - small[..., 2]).mean() / 4)
            sat = float(np.abs(small.max(axis=-1) - small.min(axis=-1)).mean() / 2)
        ctx.scene_brightness = "bright" if L > 160 else "dim" if L < 85 else "mid"
        ctx.scene_temperature = "warm" if B > 6 else "cool" if B < -6 else "neutral"
        ctx.scene_saturation = "vivid" if sat > 26 else "muted" if sat < 10 else "mid"
        bits = []
        if ctx.scene_temperature != "neutral":
            bits.append(ctx.scene_temperature)
        if ctx.scene_brightness != "mid":
            bits.append(ctx.scene_brightness)
        pal = {"vivid": "vivid colors", "muted": "muted colors", "mid": None}[ctx.scene_saturation]
        desc = ", ".join(bits) + (" lighting" if bits else "natural lighting")
        ctx.scene_desc = f"{desc}" + (f", {pal}" if pal else "")
    except Exception:
        ctx.scene_desc = None  # scene stats are a bonus, never a blocker
    return ctx
