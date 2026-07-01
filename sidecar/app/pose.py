"""Pose skeleton — data model, extraction (DWpose/OpenPose on the 4070, mannequin fallback
everywhere), and OpenPose control-image rendering (contract #6 feeds the pose ControlNet
adapters). All keypoints live in IMAGE SPACE (contract #1) so the editor's gestures round-trip.

The *edited* skeleton — not the raw extraction — becomes the control signal, so the fallback
deliberately returns a plausible default A-pose (flagged low-confidence) that the user fixes by
hand. On the target GPU, set NEUCLIP_DWPOSE=1 (+ optional NEUCLIP_DWPOSE_* weights) to use a
real estimator; without it we never fail — we hand back an editable rig.

Topology: OpenPose COCO-18 body (the ControlNet-standard). Face (70) / hand (21×2) groups are
optional and only appear when an estimator provides them; the renderer draws whatever bones a
figure carries, so richer groups need no renderer change.
"""
from __future__ import annotations

import os
from typing import Dict, List, Optional, Tuple

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore


# --- COCO-18 body topology (id, name, group) --------------------------------
# Order matches the OpenPose COCO model so a real estimator's output maps 1:1.
BODY_NAMES: List[str] = [
    "nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow",
    "l_wrist", "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle",
    "r_eye", "l_eye", "r_ear", "l_ear",
]

# Canonical A-pose layout, normalized to a centered figure box (x,y in 0..1).
_APOSE: List[Tuple[float, float]] = [
    (0.50, 0.09), (0.50, 0.18), (0.42, 0.20), (0.36, 0.32), (0.32, 0.44),
    (0.58, 0.20), (0.64, 0.32), (0.68, 0.44), (0.455, 0.50), (0.45, 0.70),
    (0.45, 0.92), (0.545, 0.50), (0.55, 0.70), (0.55, 0.92), (0.47, 0.075),
    (0.53, 0.075), (0.44, 0.09), (0.56, 0.09),
]

# 17 body limbs (pairs of keypoint indices) + the OpenPose limb colors (RGB).
BODY_LIMBS: List[Tuple[int, int]] = [
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10),
    (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16), (0, 15), (15, 17),
]
LIMB_COLORS: List[Tuple[int, int, int]] = [
    (153, 0, 0), (153, 51, 0), (153, 102, 0), (153, 153, 0), (102, 153, 0),
    (51, 153, 0), (0, 153, 0), (0, 153, 51), (0, 153, 102), (0, 153, 153),
    (0, 102, 153), (0, 51, 153), (0, 0, 153), (51, 0, 153), (102, 0, 153),
    (153, 0, 153), (153, 0, 102),
]
POINT_COLORS: List[Tuple[int, int, int]] = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0),
    (85, 255, 0), (0, 255, 0), (0, 255, 85), (0, 255, 170), (0, 255, 255),
    (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255), (170, 0, 255),
    (255, 0, 255), (255, 0, 170), (255, 0, 85),
]


def _kp_id(figure_id: str, group: str, index: int) -> str:
    return f"{figure_id}:{group}:{index}"


def bone_key(a: str, b: str) -> str:
    return f"{a}|{b}"


def default_figure(
    width: int, height: int, figure_id: str = "fig1",
    *, cx: float = 0.5, cy: float = 0.5, scale: float = 0.82, confidence: float = 0.0,
) -> dict:
    """A plausible A-pose mannequin centered in the image (or at cx,cy). Low confidence so the
    UI flags every joint as "estimated — verify" (a synthetic default is never trustworthy)."""
    # Figure box: height = scale*image height, width preserves the normalized aspect.
    box_h = scale * height
    box_w = box_h * 0.55
    x0 = cx * width - box_w / 2
    y0 = cy * height - box_h / 2
    kps = []
    for i, (nx, ny) in enumerate(_APOSE):
        group = "body"
        kps.append({
            "id": _kp_id(figure_id, "body", i),
            "x": round(x0 + nx * box_w, 2),
            "y": round(y0 + ny * box_h, 2),
            "visible": True,
            "confidence": confidence,
            "group": group,
        })
    bones = [[kps[a]["id"], kps[b]["id"]] for (a, b) in BODY_LIMBS]
    limb_order = {bone_key(kps[a]["id"], kps[b]["id"]): 0 for (a, b) in BODY_LIMBS}
    return {
        "id": figure_id,
        "keypoints": kps,
        "bones": bones,
        "limbOrder": limb_order,
        "transform": {"tx": 0.0, "ty": 0.0, "scale": 1.0, "rotation": 0.0},
    }


# --- extraction -------------------------------------------------------------

class PoseEstimator:
    """DWpose/OpenPose on the target GPU when NEUCLIP_DWPOSE is set + deps present; otherwise a
    mannequin fallback so the editor always has a rig to edit."""

    def __init__(self) -> None:
        self.backend = "fallback"
        self._detector = None
        self._try_load()

    def _try_load(self) -> None:
        if not os.environ.get("NEUCLIP_DWPOSE"):
            return
        try:  # pragma: no cover - optional heavy dep on the 4070
            from controlnet_aux import DWposeDetector  # type: ignore

            self._detector = DWposeDetector()
            self.backend = "dwpose"
        except Exception as e:  # pragma: no cover
            print(f"[pose] DWpose unavailable, using mannequin fallback: {e}")
            self._detector = None
            self.backend = "fallback"

    def extract(self, rgb: np.ndarray) -> dict:
        h, w = int(rgb.shape[0]), int(rgb.shape[1])
        if self._detector is not None:  # pragma: no cover - needs weights
            try:
                figures = self._detector_to_figures(rgb, w, h)
                if figures:
                    return {"figures": figures, "backend": self.backend, "width": w, "height": h}
            except Exception as e:
                print(f"[pose] extraction failed, falling back: {e}")
        return {"figures": [default_figure(w, h)], "backend": "fallback", "width": w, "height": h}

    def _detector_to_figures(self, rgb, w, h) -> List[dict]:  # pragma: no cover
        """Map a DWpose result (normalized candidate/subset) into our Figure dicts. Kept
        defensive: DWpose output shapes vary by version, so we read what's present."""
        result = self._detector(rgb, output_type="np", include_hand=True, include_face=True)
        # controlnet_aux returns a dict with 'bodies'/'hands'/'faces' in recent versions.
        bodies = (result or {}).get("bodies", {}) if isinstance(result, dict) else {}
        cand = np.asarray(bodies.get("candidate", []), dtype=float)
        subset = np.asarray(bodies.get("subset", []), dtype=float)
        figures: List[dict] = []
        for fi, person in enumerate(subset):
            fid = f"fig{fi + 1}"
            kps = []
            for i in range(18):
                idx = int(person[i]) if i < len(person) else -1
                if idx >= 0 and idx < len(cand):
                    x, y = cand[idx][0] * w, cand[idx][1] * h
                    conf = float(cand[idx][2]) if cand.shape[1] > 2 else 0.9
                    vis = True
                else:
                    nx, ny = _APOSE[i]
                    x, y, conf, vis = nx * w, ny * h, 0.0, False
                kps.append({
                    "id": _kp_id(fid, "body", i), "x": round(x, 2), "y": round(y, 2),
                    "visible": vis, "confidence": round(conf, 3), "group": "body",
                })
            bones = [[kps[a]["id"], kps[b]["id"]] for (a, b) in BODY_LIMBS]
            figures.append({
                "id": fid, "keypoints": kps, "bones": bones,
                "limbOrder": {bone_key(kps[a]["id"], kps[b]["id"]): 0 for (a, b) in BODY_LIMBS},
                "transform": {"tx": 0.0, "ty": 0.0, "scale": 1.0, "rotation": 0.0},
            })
        return figures


_estimator: Optional[PoseEstimator] = None


def estimator() -> PoseEstimator:
    global _estimator
    if _estimator is None:
        _estimator = PoseEstimator()
    return _estimator


def extract_pose(rgb: np.ndarray) -> dict:
    return estimator().extract(rgb)


# --- control-image render (OpenPose colored skeleton on black) ---------------

def _apply_transform(kp: dict, tf: dict, cx: float, cy: float) -> Tuple[float, float]:
    """Figure transform applied about the figure centre (tx/ty/scale/rotation)."""
    import math

    x, y = kp["x"], kp["y"]
    s = tf.get("scale", 1.0) or 1.0
    rot = math.radians(tf.get("rotation", 0.0) or 0.0)
    dx, dy = (x - cx) * s, (y - cy) * s
    rx = dx * math.cos(rot) - dy * math.sin(rot)
    ry = dx * math.sin(rot) + dy * math.cos(rot)
    return cx + rx + tf.get("tx", 0.0), cy + ry + tf.get("ty", 0.0)


def render_control_image(pose: dict, width: int, height: int) -> np.ndarray:
    """Render the OpenPose control image: colored limb ellipses + joint dots on black.
    Bones are drawn back→front by per-limb `limbOrder` (higher = further back, drawn first)
    so depth/occlusion reads correctly. Returns (H,W,3) uint8. Pure-numpy fallback if cv2 is
    absent (thick lines instead of ellipses — still a valid control signal)."""
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    for fig in pose.get("figures", []):
        by_id = {k["id"]: k for k in fig["keypoints"]}
        tf = fig.get("transform", {}) or {}
        xs = [k["x"] for k in fig["keypoints"]]
        ys = [k["y"] for k in fig["keypoints"]]
        cx, cy = (sum(xs) / len(xs), sum(ys) / len(ys)) if xs else (width / 2, height / 2)
        limb_order = fig.get("limbOrder", {}) or {}

        # Colour lookup by body-limb index; unknown bones (face/hands) get a neutral colour.
        color_for = {}
        for li, (a, b) in enumerate(BODY_LIMBS):
            ka = _id_at(fig, "body", a)
            kb = _id_at(fig, "body", b)
            if ka and kb:
                color_for[bone_key(ka, kb)] = LIMB_COLORS[li % len(LIMB_COLORS)]

        bones = list(fig.get("bones", []))
        bones.sort(key=lambda ab: -float(limb_order.get(bone_key(ab[0], ab[1]), 0)))
        for a_id, b_id in bones:
            ka, kb = by_id.get(a_id), by_id.get(b_id)
            if not ka or not kb or not ka.get("visible", True) or not kb.get("visible", True):
                continue
            col = color_for.get(bone_key(a_id, b_id), (200, 200, 200))
            ax, ay = _apply_transform(ka, tf, cx, cy)
            bx, by = _apply_transform(kb, tf, cx, cy)
            _draw_limb(canvas, ax, ay, bx, by, col)

        for k in fig["keypoints"]:
            if not k.get("visible", True):
                continue
            px, py = _apply_transform(k, tf, cx, cy)
            gi = _body_index(k["id"])
            col = POINT_COLORS[gi % len(POINT_COLORS)] if gi is not None else (255, 255, 255)
            _draw_joint(canvas, px, py, col)
    return canvas


def _id_at(fig: dict, group: str, index: int) -> Optional[str]:
    want = f":{group}:{index}"
    for k in fig["keypoints"]:
        if k["id"].endswith(want):
            return k["id"]
    return None


def _body_index(kp_id: str) -> Optional[int]:
    parts = kp_id.split(":")
    if len(parts) == 3 and parts[1] == "body":
        try:
            return int(parts[2])
        except ValueError:
            return None
    return None


def _draw_limb(canvas, ax, ay, bx, by, color) -> None:
    import math

    stick = max(2, int(round(min(canvas.shape[:2]) * 0.006)))
    if cv2 is not None:
        mx, my = (ax + bx) / 2, (ay + by) / 2
        length = math.hypot(ax - bx, ay - by)
        angle = math.degrees(math.atan2(ay - by, ax - bx))
        poly = cv2.ellipse2Poly(
            (int(round(mx)), int(round(my))), (int(round(length / 2)), stick),
            int(angle), 0, 360, 1,
        )
        cv2.fillConvexPoly(canvas, poly, [int(c) for c in color])
    else:
        _np_thick_line(canvas, ax, ay, bx, by, color, stick)


def _draw_joint(canvas, px, py, color) -> None:
    r = max(2, int(round(min(canvas.shape[:2]) * 0.008)))
    if cv2 is not None:
        cv2.circle(canvas, (int(round(px)), int(round(py))), r, [int(c) for c in color], -1)
    else:
        _np_disc(canvas, px, py, r, color)


def _np_thick_line(canvas, ax, ay, bx, by, color, half) -> None:
    h, w = canvas.shape[:2]
    n = max(2, int(np.hypot(ax - bx, ay - by)))
    for t in np.linspace(0, 1, n):
        x, y = ax + (bx - ax) * t, ay + (by - ay) * t
        _np_disc(canvas, x, y, half, color)


def _np_disc(canvas, px, py, r, color) -> None:
    h, w = canvas.shape[:2]
    x0, x1 = max(0, int(px - r)), min(w, int(px + r + 1))
    y0, y1 = max(0, int(py - r)), min(h, int(py + r + 1))
    if x0 >= x1 or y0 >= y1:
        return
    ys, xs = np.ogrid[y0:y1, x0:x1]
    mask = (xs - px) ** 2 + (ys - py) ** 2 <= r * r
    canvas[y0:y1, x0:x1][mask] = color
