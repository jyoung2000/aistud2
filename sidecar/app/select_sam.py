"""Smart selection — SAM 2 on the target GPU, classical CPU fallback everywhere else.

SAM 2 (encode-once / decode-many) is used when the `sam2` package + a checkpoint are present
(set NEUCLIP_SAM2_CHECKPOINT and NEUCLIP_SAM2_CONFIG). On the headless/CPU dev box — or any
machine without weights — we fall back to OpenCV GrabCut (box prompt) / flood region-grow
(point prompts) so /select always returns a usable mask. The mask contract is identical
either way: a uint8 (H,W) array, 255 = selected.
"""
from __future__ import annotations

import os
from typing import List, Optional, Sequence

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore

from app.device import detect_device

Point = Sequence[float]  # (x, y)
Box = Sequence[float]  # (x0, y0, x1, y1)


class SmartSelector:
    def __init__(self) -> None:
        self.image: Optional[np.ndarray] = None  # RGB
        self.predictor = None
        self.backend = "fallback"
        self._embedded_for_id: Optional[str] = None
        self._try_load_sam()

    # --- SAM 2 (target GPU) ---------------------------------------------------
    def _try_load_sam(self) -> None:
        ckpt = os.environ.get("NEUCLIP_SAM2_CHECKPOINT")
        cfg = os.environ.get("NEUCLIP_SAM2_CONFIG")
        if not ckpt or not cfg:
            return
        try:
            import torch  # type: ignore
            from sam2.build_sam import build_sam2  # type: ignore
            from sam2.sam2_image_predictor import SAM2ImagePredictor  # type: ignore

            device = detect_device()["device"]
            model = build_sam2(cfg, ckpt, device=device)
            self.predictor = SAM2ImagePredictor(model)
            self.backend = "sam2"
            # autocast on CUDA for speed/memory
            self._torch = torch
        except Exception as e:  # pragma: no cover - depends on optional heavy deps
            print(f"[select] SAM 2 unavailable, using fallback: {e}")
            self.predictor = None
            self.backend = "fallback"

    def set_image(self, rgb: np.ndarray, image_id: str) -> None:
        """Encode once per image (SAM caches the embedding internally)."""
        self.image = rgb
        if self.backend == "sam2" and self._embedded_for_id != image_id:
            self.predictor.set_image(rgb)
            self._embedded_for_id = image_id

    # --- public select --------------------------------------------------------
    def select(
        self,
        points: List[Point],
        labels: List[int],
        box: Optional[Box],
    ) -> np.ndarray:
        if self.image is None:
            raise RuntimeError("no image set")
        if self.backend == "sam2":
            return self._select_sam(points, labels, box)
        return self._select_fallback(points, labels, box)

    def _select_sam(self, points, labels, box) -> np.ndarray:  # pragma: no cover
        pc = np.array(points, dtype=np.float32) if points else None
        pl = np.array(labels, dtype=np.int32) if labels else None
        bx = np.array(box, dtype=np.float32) if box is not None else None
        ctx = (
            self._torch.autocast("cuda", dtype=self._torch.bfloat16)
            if detect_device()["cuda"]
            else _nullcontext()
        )
        with self._torch.inference_mode(), ctx:
            masks, scores, _ = self.predictor.predict(
                point_coords=pc, point_labels=pl, box=bx, multimask_output=True
            )
        best = masks[int(np.argmax(scores))]
        return (best > 0).astype(np.uint8) * 255

    # --- classical fallback ---------------------------------------------------
    def _select_fallback(self, points, labels, box) -> np.ndarray:
        assert cv2 is not None, "OpenCV required for fallback select"
        img = self.image
        h, w = img.shape[:2]
        bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

        if box is not None:
            return self._grabcut(bgr, box, h, w)

        pos = [p for p, l in zip(points, labels) if l == 1]
        if not pos:
            return np.zeros((h, w), np.uint8)

        mask = self._floodfill(bgr, pos[0], h, w)
        for p in pos[1:]:
            mask = np.maximum(mask, self._floodfill(bgr, p, h, w))
        for p, l in zip(points, labels):
            if l == 0:
                mask[self._floodfill(bgr, p, h, w) > 0] = 0
        return mask

    @staticmethod
    def _grabcut(bgr, box, h, w) -> np.ndarray:
        x0, y0, x1, y1 = [int(v) for v in box]
        rect = (max(0, x0), max(0, y0), max(1, x1 - x0), max(1, y1 - y0))
        gc = np.zeros((h, w), np.uint8)
        bgd = np.zeros((1, 65), np.float64)
        fgd = np.zeros((1, 65), np.float64)
        cv2.grabCut(bgr, gc, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
        return np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)

    @staticmethod
    def _floodfill(bgr, point, h, w, tol=14) -> np.ndarray:
        seed = (int(np.clip(point[0], 0, w - 1)), int(np.clip(point[1], 0, h - 1)))
        ffmask = np.zeros((h + 2, w + 2), np.uint8)
        flags = 4 | (255 << 8) | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE
        cv2.floodFill(bgr.copy(), ffmask, seed, 0, (tol,) * 3, (tol,) * 3, flags)
        return (ffmask[1:-1, 1:-1] > 0).astype(np.uint8) * 255


class _nullcontext:
    def __enter__(self):
        return None

    def __exit__(self, *a):
        return False
