"""Seam harmonization — make an inpaint stop looking pasted (run after generation, before
composite). Operates on the result crop using a ring of surrounding (unselected) pixels as
the target:

- color match : Reinhard-style LAB mean/std transfer of the selection toward the surround.
- relight     : match the low-frequency luminance gradient of the surround.
- grain match : add high-frequency noise matching the local grain.
- edge blend  : handled by the existing feathered alpha in compose.composite_back.

All effects are scaled by a single `strength` and applied ONLY inside the selection.
"""
from __future__ import annotations

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore


def _stats(lab: np.ndarray, mask: np.ndarray):
    px = lab[mask > 0]
    if px.size == 0:
        return None, None
    return px.mean(axis=0), px.std(axis=0) + 1e-6


def harmonize(base_rgb: np.ndarray, region, result_crop: np.ndarray, crop_mask: np.ndarray, opts: dict) -> np.ndarray:
    if cv2 is None:
        return result_crop
    x0, y0, x1, y1 = region
    base_region = base_rgb[y0 : y1 + 1, x0 : x1 + 1]
    if base_region.shape[:2] != result_crop.shape[:2]:
        return result_crop
    strength = float(opts.get("strength", 0.6))
    sel = crop_mask > 0
    surround = crop_mask == 0
    out = result_crop.astype(np.float32)
    sel3 = sel[..., None]

    if opts.get("colorMatch", True) and surround.any() and sel.any():
        lab_res = cv2.cvtColor(result_crop, cv2.COLOR_RGB2LAB).astype(np.float32)
        lab_sur = cv2.cvtColor(base_region, cv2.COLOR_RGB2LAB).astype(np.float32)
        sm, ss = _stats(lab_sur, surround.astype(np.uint8))
        rm, rs = _stats(lab_res, sel.astype(np.uint8))
        if sm is not None and rm is not None:
            adj = (lab_res - rm) / rs * ss + sm
            lab_new = lab_res * (1 - strength) + adj * strength
            rgb_new = cv2.cvtColor(np.clip(lab_new, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
            out = np.where(sel3, rgb_new, out)

    if opts.get("relight", True) and sel.any():
        g_res = cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
        g_base = cv2.cvtColor(base_region, cv2.COLOR_RGB2GRAY).astype(np.float32)
        lf = cv2.GaussianBlur(g_base, (0, 0), 15) - cv2.GaussianBlur(g_res, (0, 0), 15)
        out = np.where(sel3, np.clip(out + (lf * strength)[..., None], 0, 255), out)

    if opts.get("grainMatch", True) and surround.any() and sel.any():
        g_base = cv2.cvtColor(base_region, cv2.COLOR_RGB2GRAY).astype(np.float32)
        hf = g_base - cv2.GaussianBlur(g_base, (0, 0), 1.5)
        noise_std = float(hf[surround].std())
        if noise_std > 0.5:
            noise = np.random.RandomState(0).normal(0, noise_std * strength, out.shape[:2])[..., None]
            out = np.where(sel3, np.clip(out + noise, 0, 255), out)

    return np.clip(out, 0, 255).astype(np.uint8)
