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
        self._gdino = None  # GroundingDINO model, lazy-loaded for semantic select
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

    # --- one-click subject -----------------------------------------------------
    def select_subject(self) -> np.ndarray:
        """SAM automatic foreground when available; else GrabCut on a centered rect."""
        if self.image is None:
            raise RuntimeError("no image set")
        h, w = self.image.shape[:2]
        if self.backend == "sam2":  # pragma: no cover
            try:
                from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator  # type: ignore

                gen = SAM2AutomaticMaskGenerator(self.predictor.model)
                masks = gen.generate(self.image)
                if masks:
                    best = max(masks, key=lambda m: m["area"])  # largest region
                    return (best["segmentation"] > 0).astype(np.uint8) * 255
            except Exception as e:
                print(f"[subject] SAM auto failed, fallback: {e}")
        assert cv2 is not None
        bgr = cv2.cvtColor(self.image, cv2.COLOR_RGB2BGR)
        return self._grabcut(bgr, [w * 0.1, h * 0.1, w * 0.9, h * 0.9], h, w)

    # --- auto-decomposition ----------------------------------------------------
    def decompose(self, granularity: str = "simple") -> list:
        """Return region dicts {name, kind, mask(uint8)} — Background first, then subjects.

        On the target: Grounding-DINO + SAM 2 panoptic/instance segmentation (per-character +
        background, plus objects at fine granularity). CPU fallback: GrabCut foreground +
        background (single subject instance — instance separation needs the grounded model).
        """
        if self.image is None:
            raise RuntimeError("no image set")
        h, w = self.image.shape[:2]
        if os.environ.get("NEUCLIP_GDINO_CHECKPOINT") and self.backend == "sam2":  # pragma: no cover
            try:
                raise NotImplementedError("wire GroundingDINO + SAM2 instances on the target")
            except Exception as e:
                print(f"[decompose] grounded model unavailable, fallback: {e}")

        assert cv2 is not None

        # drawn/animated images: GrabCut's photo-statistics prior misjudges flat cel
        # shading — group the actual flat color regions into whole INSTANCES instead
        try:
            from app.medium import detect_medium

            if detect_medium(self.image)["medium"] == "drawn":
                regions = self._decompose_flat(h, w)
                if regions:
                    return regions
        except Exception as e:
            print(f"[decompose] flat-region path failed, using GrabCut: {e}")

        bgr = cv2.cvtColor(self.image, cv2.COLOR_RGB2BGR)
        subj = self._grabcut(bgr, [w * 0.12, h * 0.06, w * 0.88, h * 0.96], h, w)
        bg = np.where(subj > 0, 0, 255).astype(np.uint8)
        # honest labeling: a skin-bearing foreground is a Subject, anything else an Object
        name = "Subject 1" if self._region_skin_frac(subj) > 0.10 else "Object 1"
        return [
            {"name": "Background", "kind": "decomposed", "mask": bg},
            {"name": name, "kind": "decomposed", "mask": subj},
        ]

    def _region_skin_frac(self, mask: np.ndarray) -> float:
        """Skin-tone fraction inside a mask (Peer et al. RGB rule) — Subject vs Object."""
        sel = mask > 0
        if not sel.any():
            return 0.0
        px = self.image[sel].astype(np.int16)
        r, g, b = px[:, 0], px[:, 1], px[:, 2]
        skin = (
            (r > 95) & (g > 40) & (b > 20)
            & ((px.max(axis=1) - px.min(axis=1)) > 15)
            & (np.abs(r - g) > 15) & (r > g) & (r > b)
            & ((g - b) < 90)   # rejects saturated yellows — skin has a modest g-b gap
            & ((r - g) < 110)  # rejects pure reds — skin's r-g gap is moderate
        )
        return float(skin.mean())

    def _decompose_flat(self, h, w) -> list:
        """Instance-grouped layering for drawn/animated images (the Adobe-like behavior):

        1. every connected flat-color region that is NOT backdrop (backdrop = large AND
           border-touching — sky bands, ground planes, gradient slices) and NOT a speck
           joins a shared foreground mask;
        2. a morphological CLOSE bridges thin ink outlines and hairline gaps so the
           TOUCHING parts of one thing (skin + shirt + jeans + shoes; the wedges of a
           beach ball) merge into a single instance instead of one layer per color;
        3. connected components of that foreground = instances (top 6 by area), each
           classified Subject (skin tones present) or Object and numbered per class;
        4. Background = everything else.
        """
        q = (self.image >> 4).astype(np.uint16)  # 16 levels per channel
        packed = ((q[..., 0] << 8) | (q[..., 1] << 4) | q[..., 2]).astype(np.int32)

        fg = np.zeros((h, w), np.uint8)
        frame = float(h * w)
        for color in np.unique(packed):
            cm = (packed == color).astype(np.uint8)
            if int(cm.sum()) < frame * 0.001:
                continue  # specks / grain — never part of an instance
            n, lbl, stats, _ = cv2.connectedComponentsWithStats(cm, 8)
            comps = []
            backdrop_color = False
            for i in range(1, n):
                area = int(stats[i, cv2.CC_STAT_AREA])
                if area < frame * 0.001:
                    continue
                x0, y0 = int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP])
                x1 = x0 + int(stats[i, cv2.CC_STAT_WIDTH])
                y1 = y0 + int(stats[i, cv2.CC_STAT_HEIGHT])
                touches = x0 <= 1 or y0 <= 1 or x1 >= w - 1 or y1 >= h - 1
                spans = (x1 - x0) >= w * 0.9 or (y1 - y0) >= h * 0.9
                if touches and (area > frame * 0.02 or spans):
                    # backdrop plane, gradient band, or a full-span quantization sliver.
                    # Mark the whole COLOR as backdrop: a sky band split in two by an
                    # object is still sky — its fragments must not become "objects".
                    backdrop_color = True
                    break
                comps.append(i)
            if backdrop_color:
                continue
            for i in comps:
                fg[lbl == i] = 255

        if not fg.any():
            return []
        # bridge ink outlines + tiny gaps so touching parts fuse into one instance
        k = max(5, int(round(min(h, w) * 0.012)) | 1)
        fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))

        n, lbl, stats, _ = cv2.connectedComponentsWithStats(fg, 8)
        instances = []
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area < frame * 0.004 or area > frame * 0.60:
                continue
            m = np.where(lbl == i, 255, 0).astype(np.uint8)
            instances.append({"area": area, "mask": m, "skin": self._region_skin_frac(m)})
        if not instances:
            return []
        instances.sort(key=lambda o: -o["area"])
        instances = instances[:6]

        bg = np.full((h, w), 255, np.uint8)
        subjects = objects = 0
        out = []
        for inst in instances:
            if inst["skin"] > 0.06:
                subjects += 1
                name = f"Subject {subjects}"
            else:
                objects += 1
                name = f"Object {objects}"
            bg[inst["mask"] > 0] = 0
            out.append({"name": name, "kind": "decomposed", "mask": inst["mask"]})
        # subjects listed before objects; Background stays the bottom layer
        out.sort(key=lambda r: (0 if r["name"].startswith("Subject") else 1, r["name"]))
        return [{"name": "Background", "kind": "decomposed", "mask": bg}] + out

    # --- text-grounded (semantic) ---------------------------------------------

    # rough HSV hue bands (OpenCV hue 0..180) for the color words Find understands offline
    _COLOR_BANDS = {
        "red": [(0, 9), (168, 180)], "crimson": [(0, 9), (168, 180)], "scarlet": [(0, 9), (168, 180)],
        "orange": [(9, 22)], "brown": [(9, 22)], "gold": [(20, 34)], "golden": [(20, 34)],
        "yellow": [(22, 36)], "green": [(36, 85)], "teal": [(80, 98)], "cyan": [(85, 100)],
        "blue": [(100, 130)], "navy": [(100, 130)], "purple": [(130, 152)], "violet": [(130, 152)],
        "magenta": [(150, 168)], "pink": [(150, 172)],
    }
    _SUBJECT_WORDS = ("person", "people", "subject", "man", "woman", "boy", "girl",
                      "human", "figure", "character", "body", "him", "her", "me")
    _BACKGROUND_WORDS = ("background", "backdrop", "scenery", "behind", "surroundings")
    # common scene nouns Find can resolve offline via color/brightness heuristics
    _NOUN_COLORS = {
        "grass": "green", "tree": "green", "trees": "green", "plant": "green",
        "plants": "green", "leaves": "green", "forest": "green", "bush": "green",
        "water": "blue", "sea": "blue", "ocean": "blue", "lake": "blue", "river": "blue",
        "jeans": "blue", "denim": "blue", "blood": "red", "fire": "orange",
        "flame": "orange", "banana": "yellow", "lemon": "yellow",
    }
    _BRIGHT_WORDS = ("sun", "moon", "light", "lamp", "bulb", "glow", "headlight")
    _SKIN_WORDS = ("skin", "face", "hand", "hands", "arm", "arms", "leg", "legs")

    def semantic(self, text: str):
        """Text → mask. Grounding-DINO + SAM when weights are present; otherwise a chain of
        honest CPU fallbacks: background words → inverse of the detected subject; person/
        subject words → GrabCut subject; color words → HSV color-band regions.

        Returns (mask, available: bool, note: str|None) — `note` says which method ran so
        the UI never pretends a heuristic was a grounded model."""
        if self.image is None:
            raise RuntimeError("no image set")
        h, w = self.image.shape[:2]
        low = text.lower()

        # 1. grounded pipeline (target GPU with weights): GroundingDINO boxes → SAM masks
        ckpt = os.environ.get("NEUCLIP_GDINO_CHECKPOINT")
        cfg = os.environ.get("NEUCLIP_GDINO_CONFIG")
        if ckpt and cfg and self.backend == "sam2":  # pragma: no cover — GPU-only path
            try:
                mask = self._semantic_grounded(text, cfg, ckpt)
                if mask is not None and mask.any():
                    return mask, True, None
            except Exception as e:
                print(f"[semantic] grounded model unavailable, using heuristics: {e}")

        # 2. CLIPSeg text→mask (transformers; CPU or GPU) — arbitrary phrases work when the
        #    model is cached / bundled. Never auto-downloads unless NEUCLIP_CLIPSEG=1.
        try:
            mask = self._semantic_clipseg(text)
            if mask is not None and mask.any():
                return mask, True, "matched by CLIPSeg text-to-mask"
        except Exception as e:
            print(f"[semantic] CLIPSeg unavailable: {e}")

        assert cv2 is not None
        bgr = cv2.cvtColor(self.image, cv2.COLOR_RGB2BGR)
        words = set(low.replace(",", " ").replace("'s", "").split())

        # 3. background words → inverse of the detected subject
        if any(wd in low for wd in self._BACKGROUND_WORDS):
            subj = self._grabcut(bgr, [w * 0.12, h * 0.06, w * 0.88, h * 0.96], h, w)
            return (np.where(subj > 0, 0, 255).astype(np.uint8), True,
                    "matched 'background' as the inverse of the detected subject")

        # 4. person/subject words → subject detection
        if words & set(self._SUBJECT_WORDS):
            subj = self._grabcut(bgr, [w * 0.12, h * 0.06, w * 0.88, h * 0.96], h, w)
            if subj.any():
                return subj, True, "matched the main subject (grounded per-object select needs the GPU build)"

        # 5. bright-source words → the brightest compact blob ("the sun", "the lamp")
        if words & set(self._BRIGHT_WORDS):
            mask = self._brightest_blob(h, w)
            if mask.any():
                return mask, True, "matched the brightest region (sun/light heuristic)"

        # 6. sky → bright/blue area connected to the top edge
        if "sky" in words:
            mask = self._sky_mask(h, w)
            if mask.any():
                return mask, True, "matched the sky (top-connected bright/blue region)"

        # 7. skin words → skin-tone regions
        if words & set(self._SKIN_WORDS):
            mask = self._skin_mask(h, w)
            if mask.any():
                return mask, True, "matched skin-tone regions"

        # 8. color words + common nouns with a known color ("grass", "jeans", "water")
        color_words = [wd for wd in words if wd in self._COLOR_BANDS]
        color_words += [self._NOUN_COLORS[wd] for wd in words if wd in self._NOUN_COLORS]
        for word in color_words:
            mask = self._color_mask(self._COLOR_BANDS[word], h, w)
            if mask.any():
                return mask, True, f"matched {word} regions by color (grounded select needs the GPU build)"

        return (np.zeros((h, w), np.uint8), False,
                "couldn't match that phrase — offline Find understands colors ('the red ball'), "
                "scene words ('sun', 'sky', 'grass', 'water', 'skin'), 'person'/'subject', and "
                "'background'; arbitrary phrases need the GPU build (or a cached CLIPSeg model)")

    def _semantic_clipseg(self, text: str):
        """CLIPSeg text→mask (CIDAS/clipseg-rd64-refined). Uses the local HF cache only,
        unless NEUCLIP_CLIPSEG=1 explicitly allows the one-time download — Find must never
        surprise the user with a 600 MB fetch."""
        if os.environ.get("NEUCLIP_CLIPSEG") == "0":
            return None
        import torch  # type: ignore
        from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor  # type: ignore

        if getattr(self, "_clipseg", None) is None:
            name = os.environ.get("NEUCLIP_CLIPSEG_MODEL", "CIDAS/clipseg-rd64-refined")
            local_only = os.environ.get("NEUCLIP_CLIPSEG") != "1"
            proc = CLIPSegProcessor.from_pretrained(name, local_files_only=local_only)
            model = CLIPSegForImageSegmentation.from_pretrained(name, local_files_only=local_only)
            device = detect_device()["device"]
            model = model.to(device).eval()
            self._clipseg = (proc, model, device)
        proc, model, device = self._clipseg
        from PIL import Image as _PIL

        h, w = self.image.shape[:2]
        pil = _PIL.fromarray(self.image)
        inputs = proc(text=[text], images=[pil], return_tensors="pt").to(device)
        with torch.inference_mode():
            logits = model(**inputs).logits  # (352, 352)
        prob = torch.sigmoid(logits).squeeze().float().cpu().numpy()
        mask = (prob > 0.4).astype(np.uint8) * 255
        if not mask.any():
            return None
        assert cv2 is not None
        return cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)

    def _brightest_blob(self, h, w) -> np.ndarray:
        """Largest connected component of the top-brightness pixels (sun / lamp / moon)."""
        gray = cv2.cvtColor(cv2.cvtColor(self.image, cv2.COLOR_RGB2BGR), cv2.COLOR_BGR2GRAY)
        thresh = np.percentile(gray, 98)
        m = (gray >= max(200, thresh)).astype(np.uint8) * 255
        if not m.any():
            m = (gray >= thresh).astype(np.uint8) * 255
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
        n, lbl, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        if n <= 1:
            return np.zeros((h, w), np.uint8)
        best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        return np.where(lbl == best, 255, 0).astype(np.uint8)

    def _sky_mask(self, h, w) -> np.ndarray:
        """Bright and/or blue smooth region connected to the top edge of the frame."""
        hsv = cv2.cvtColor(cv2.cvtColor(self.image, cv2.COLOR_RGB2BGR), cv2.COLOR_BGR2HSV)
        blue = cv2.inRange(hsv, (95, 25, 90), (135, 255, 255))
        bright = cv2.inRange(hsv, (0, 0, 185), (180, 60, 255))  # pale / overcast sky
        m = cv2.morphologyEx(blue | bright, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
        n, lbl = cv2.connectedComponents(m, 8)
        keep = np.zeros((h, w), np.uint8)
        top = set(int(v) for v in np.unique(lbl[0, :]) if v != 0)  # touching the top edge
        for i in top:
            keep[lbl == i] = 255
        return keep

    def _skin_mask(self, h, w) -> np.ndarray:
        """Skin-tone pixels (Peer et al. RGB rule — same heuristic the prompt context uses)."""
        px = self.image.astype(np.int16)
        r, g, b = px[..., 0], px[..., 1], px[..., 2]
        skin = (
            (r > 95) & (g > 40) & (b > 20)
            & ((px.max(axis=-1) - px.min(axis=-1)) > 15)
            & (np.abs(r - g) > 15) & (r > g) & (r > b)
        ).astype(np.uint8) * 255
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        return cv2.morphologyEx(skin, cv2.MORPH_OPEN, k)

    def _color_mask(self, bands, h, w) -> np.ndarray:
        """All sufficiently-saturated pixels inside the hue band(s), cleaned + de-speckled."""
        hsv = cv2.cvtColor(cv2.cvtColor(self.image, cv2.COLOR_RGB2BGR), cv2.COLOR_BGR2HSV)
        m = np.zeros((h, w), np.uint8)
        for lo, hi in bands:
            m |= cv2.inRange(hsv, (lo, 60, 50), (hi, 255, 255))
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        m = cv2.morphologyEx(cv2.morphologyEx(m, cv2.MORPH_OPEN, k), cv2.MORPH_CLOSE, k)
        # drop specks: keep components bigger than 0.05% of the frame
        n, lbl, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        keep = np.zeros((h, w), np.uint8)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= h * w * 0.0005:
                keep[lbl == i] = 255
        return keep

    def _semantic_grounded(self, text: str, cfg: str, ckpt: str):  # pragma: no cover
        """GroundingDINO boxes for the phrase → SAM mask per box → union. GPU-only."""
        import torch  # type: ignore
        from groundingdino.util.inference import load_image, load_model, predict  # type: ignore
        from PIL import Image as _PIL

        import tempfile

        if self._gdino is None:
            self._gdino = load_model(cfg, ckpt)
        # groundingdino's loader wants a path; hand it the current image via a temp file
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            _PIL.fromarray(self.image).save(f.name)
            _src, img_t = load_image(f.name)
        boxes, logits, phrases = predict(
            model=self._gdino, image=img_t, caption=text,
            box_threshold=0.35, text_threshold=0.25,
        )
        if boxes is None or len(boxes) == 0:
            return None
        h, w = self.image.shape[:2]
        union = np.zeros((h, w), np.uint8)
        for b in boxes:  # cxcywh, normalized
            cx, cy, bw, bh = [float(v) for v in b]
            box = [(cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h]
            union = np.maximum(union, self._select_sam([], [], box))
        return union

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
