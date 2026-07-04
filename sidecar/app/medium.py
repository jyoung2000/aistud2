"""Image-medium detection: photo vs drawn/animated vs 3D/CG render.

Why it matters: the prompt compiler must never ask a model for "photorealistic, detailed"
content inside a cel-shaded drawing (or vice versa) — an edit that ignores the medium
sticks out worse than a bad seam. This is a CPU statistics classifier (no ML weights):

- **drawn / animated** — large flat same-color regions (a few quantized colors cover most
  pixels) and/or strong dark outlines. Cel shading and line art are exactly this.
- **photo** — continuous gradients plus per-pixel sensor noise (high-frequency residual
  everywhere, even in "smooth" areas).
- **render_cg** — smooth, noise-free gradients WITHOUT the flat fills of a drawing:
  3D renders are continuous like photos but statistically far cleaner.

Every verdict ships with its cues + a confidence so the UI can show (and let the user
override) the guess honestly. Runs on a ≤256px downsample — sub-millisecond-ish.
"""
from __future__ import annotations

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore

MEDIUMS = ("photo", "drawn", "render_cg")

# human phrasing the prompt compiler splices into clauses
MEDIUM_DESC = {
    "photo": "a photograph",
    "drawn": "a drawn / animated illustration (flat shading, line art)",
    "render_cg": "a 3D / CG render",
}


def _stats(rgb: np.ndarray) -> dict:
    h, w = rgb.shape[:2]
    step = max(1, max(h, w) // 256)
    small = rgb[::step, ::step]
    sh, sw = small.shape[:2]
    n = sh * sw

    # flatness: how much of the frame the 16 most common quantized colors cover
    q = (small >> 4).astype(np.uint16)  # 16 levels/channel
    packed = (q[..., 0] << 8) | (q[..., 1] << 4) | q[..., 2]
    counts = np.bincount(packed.ravel(), minlength=4096)
    flat_frac = float(np.sort(counts)[-16:].sum() / n)

    gray = (0.299 * small[..., 0] + 0.587 * small[..., 1] + 0.114 * small[..., 2]).astype(np.float32)

    # noise: median |pixel − 3x3 mean| inside LOW-gradient areas (photo sensor noise
    # survives smoothing; drawings and renders are near-zero there)
    if cv2 is not None:
        mean3 = cv2.blur(gray, (3, 3))
        gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0)
        gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1)
    else:  # numpy fallback
        mean3 = gray.copy()
        mean3[1:-1, 1:-1] = (
            gray[:-2, :-2] + gray[:-2, 1:-1] + gray[:-2, 2:] +
            gray[1:-1, :-2] + gray[1:-1, 1:-1] + gray[1:-1, 2:] +
            gray[2:, :-2] + gray[2:, 1:-1] + gray[2:, 2:]
        ) / 9.0
        gy, gx = np.gradient(gray)
    resid = np.abs(gray - mean3)
    grad = np.hypot(gx, gy)
    smooth = grad < 12
    noise = float(np.median(resid[smooth])) if smooth.any() else float(np.median(resid))

    # outlines: fraction of strong-edge pixels that are also DARK (ink lines)
    strong = grad > 60
    dark_lines = float(((gray < 90) & strong).sum() / max(1, strong.sum())) if strong.any() else 0.0
    edge_frac = float(strong.mean())

    return {
        "flat_frac": round(flat_frac, 3),
        "noise": round(noise, 3),
        "dark_line_frac": round(dark_lines, 3),
        "edge_frac": round(edge_frac, 3),
    }


def detect_medium(rgb: np.ndarray) -> dict:
    """→ {medium, confidence, cues[], stats} — never raises; unknown → photo/low conf."""
    try:
        s = _stats(rgb)
    except Exception:
        return {"medium": "photo", "confidence": 0.3, "cues": ["stats failed — defaulting to photo"], "stats": {}}

    cues: list[str] = []
    # drawn: flat fills dominate, or ink outlines with clean smooth areas
    drawn_score = 0.0
    if s["flat_frac"] > 0.72:
        drawn_score += 0.6
        cues.append(f"flat color fills cover ~{round(s['flat_frac'] * 100)}% of the frame")
    elif s["flat_frac"] > 0.55:
        drawn_score += 0.3
    if s["dark_line_frac"] > 0.45 and s["noise"] < 1.2:
        drawn_score += 0.35
        cues.append("strong dark outlines (line art)")
    if s["noise"] < 0.6 and s["flat_frac"] > 0.5:
        drawn_score += 0.15

    photo_score = 0.0
    if s["noise"] > 1.6:
        photo_score += 0.65
        cues.append("per-pixel noise in smooth areas (camera sensor)")
    elif s["noise"] > 0.9:
        photo_score += 0.35
    if s["flat_frac"] < 0.4:
        photo_score += 0.3

    render_score = 0.0
    if s["noise"] < 0.9 and s["flat_frac"] < 0.55:
        render_score += 0.55
        cues.append("noise-free continuous gradients (CG-smooth)")
    if s["noise"] < 0.4 and s["flat_frac"] < 0.45:
        render_score += 0.2

    scores = {"drawn": drawn_score, "photo": photo_score, "render_cg": render_score}
    medium = max(scores, key=scores.get)  # type: ignore[arg-type]
    top = scores[medium]
    rest = sorted(scores.values())[-2]
    confidence = round(min(0.95, max(0.34, 0.5 + (top - rest))), 2)
    if top == 0:
        medium, confidence = "photo", 0.34
        cues.append("no strong medium signal — defaulting to photo")
    return {"medium": medium, "confidence": confidence, "cues": cues, "stats": s}
