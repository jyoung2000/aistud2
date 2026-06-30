"""Edge refine — BiRefNet alpha matting on the target GPU, morphological fallback on CPU.

When `transformers` + a BiRefNet checkpoint are available (NEUCLIP_BIREFNET_MODEL) we run a
real matting pass for clean hair/soft edges. Otherwise we clean and feather the binary mask
with OpenCV (open/close + edge-aware blur) so /refine always improves the boundary. Returns
a uint8 (H,W) alpha (0..255).
"""
from __future__ import annotations

import os
from typing import Optional

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore


class EdgeRefiner:
    def __init__(self) -> None:
        self.model = None
        self.backend = "fallback"
        self._try_load()

    def _try_load(self) -> None:
        model_id = os.environ.get("NEUCLIP_BIREFNET_MODEL")
        if not model_id:
            return
        try:  # pragma: no cover - heavy optional deps
            import torch  # type: ignore
            from transformers import AutoModelForImageSegmentation  # type: ignore

            from app.device import detect_device

            self._torch = torch
            self.device = detect_device()["device"]
            self.model = AutoModelForImageSegmentation.from_pretrained(
                model_id, trust_remote_code=True
            ).to(self.device).eval()
            self.backend = "birefnet"
        except Exception as e:
            print(f"[refine] BiRefNet unavailable, using fallback: {e}")
            self.model = None
            self.backend = "fallback"

    def refine(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        if self.backend == "birefnet":
            try:  # pragma: no cover
                return self._refine_birefnet(rgb, mask)
            except Exception as e:
                print(f"[refine] BiRefNet failed mid-run, falling back: {e}")
        return self._refine_fallback(rgb, mask)

    def _refine_birefnet(self, rgb, mask) -> np.ndarray:  # pragma: no cover
        import torch.nn.functional as F  # type: ignore
        from PIL import Image

        torch = self._torch
        h, w = mask.shape[:2]
        # Matte the whole image; intersect with the user's mask region so we only refine the
        # selected object's edge, not introduce new areas.
        size = 1024
        img = Image.fromarray(rgb).resize((size, size))
        x = torch.from_numpy(np.asarray(img)).permute(2, 0, 1).float().div(255)
        mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
        x = ((x - mean) / std).unsqueeze(0).to(self.device)
        with torch.inference_mode():
            pred = self.model(x)[-1].sigmoid().cpu()[0, 0]
        alpha = (pred.numpy() * 255).astype(np.uint8)
        alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_LINEAR)
        # keep matting only inside a dilated version of the user's selection
        keep = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
        alpha[keep == 0] = 0
        return alpha

    @staticmethod
    def _refine_fallback(rgb, mask) -> np.ndarray:
        if cv2 is None:
            return mask
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        m = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
        # Edge-aware feather: blur the alpha, then bias it back toward the image edges so the
        # soft band hugs real contours rather than bleeding uniformly.
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        edges = cv2.Sobel(gray, cv2.CV_32F, 1, 0) ** 2 + cv2.Sobel(gray, cv2.CV_32F, 0, 1) ** 2
        edge_w = np.clip(edges / (edges.max() + 1e-6), 0, 1).astype(np.float32)
        soft = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 1.4)
        # where image edges are strong, snap alpha back toward the hard mask
        alpha = soft * (1 - edge_w) + m.astype(np.float32) * edge_w
        return np.clip(alpha, 0, 255).astype(np.uint8)
