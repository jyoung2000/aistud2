"""Neuclip Studio sidecar — FastAPI ML service.

Phase 0: boots, picks a port (fixed-with-fallback), prints the port to stdout for the
Rust parent, and serves /health. Later phases add /load /select /refine /livewire/costmap
/generate /poll.
"""
from __future__ import annotations

import os
import socket
import sys
from pathlib import Path
from typing import Optional

import uuid

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import compose, imaging
from app import settings as settings_store
from app.constants import APP_NAME, DEFAULT_PORT, PORT_ENV, PORT_STDOUT_PREFIX
from app.device import banner, detect_device
from app.jobs import jobs
from app.matting import EdgeRefiner
from app.models import registry, wavespeed
from app.profiles import store as profile_store
from app.profiles import synth as profile_synth
from app.select_sam import SmartSelector

app = FastAPI(title=f"{APP_NAME} sidecar")

# ML singletons (lazy heavy deps; both degrade to CPU fallbacks).
_selector = SmartSelector()
_refiner = EdgeRefiner()

# The webview origin is not fixed in dev; allow all (loopback-only service).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    d = detect_device()
    return {
        "status": "ok",
        "app": APP_NAME,
        "device": d["device"],
        "gpu_name": d["gpu_name"],
        "cuda": d["cuda"],
        "torch": d["torch"],
        "torch_version": d["torch_version"],
    }


class SettingsIn(BaseModel):
    # Optional so the UI can update one key at a time. Empty string clears (falls back to env).
    wavespeed_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None


@app.get("/settings")
def get_settings() -> dict:
    """Non-secret status: which keys are set, their source, and a masked hint."""
    return settings_store.settings_status()


@app.post("/settings")
def post_settings(body: SettingsIn) -> dict:
    """Save provided keys; only fields present in the body are touched."""
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    return settings_store.save_secrets(updates)


class SelectIn(BaseModel):
    id: str
    points: list[list[float]] = []  # [[x, y], ...] in image space
    labels: list[int] = []          # 1 = positive, 0 = negative (paired with points)
    box: Optional[list[float]] = None  # [x0, y0, x1, y1]
    subject: bool = False           # one-click subject
    semantic: Optional[str] = None  # text-grounded selection


class RefineIn(BaseModel):
    id: str
    mask_png: str  # base64 PNG of the current binary mask


@app.post("/load")
async def load_image(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    rgb = imaging.load_rgb(raw)
    image_id = uuid.uuid4().hex
    session = imaging.ImageSession(image_id, rgb)
    imaging.set_active(session)
    _selector.set_image(rgb, image_id)  # SAM encodes once here
    return {
        "id": image_id,
        "width": session.width,
        "height": session.height,
        "backend": _selector.backend,
    }


@app.post("/select")
def select(body: SelectIn) -> dict:
    try:
        session = imaging.require_active(body.id)
    except KeyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    _selector.set_image(session.rgb, session.image_id)
    note = None
    if body.semantic:
        mask, available = _selector.semantic(body.semantic)
        if not available:
            note = "semantic select needs Grounding-DINO weights on the target GPU"
    elif body.subject:
        mask = _selector.select_subject()
    else:
        mask = _selector.select(body.points, body.labels, body.box)
    return {
        "mask_png": imaging.png_to_base64(mask),
        "width": session.width,
        "height": session.height,
        "backend": _selector.backend,
        "note": note,
    }


class CostMapIn(BaseModel):
    id: str
    contrast: float = 1.0


@app.post("/livewire/costmap")
def livewire_costmap(body: CostMapIn) -> dict:
    try:
        session = imaging.require_active(body.id)
    except KeyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    from app.livewire import cost_map

    cache_key = f"costmap:{body.contrast:.2f}"
    cached = session.extra.get(cache_key)
    if cached is None:
        cost, scale = cost_map(session.rgb, contrast=body.contrast)
        cached = {
            "cost_png": imaging.png_to_base64(cost),
            "cost_w": int(cost.shape[1]),
            "cost_h": int(cost.shape[0]),
            "scale": scale,
        }
        session.extra[cache_key] = cached
    return cached


class OutpaintIn(BaseModel):
    id: str
    new_w: int
    new_h: int
    dx: int  # where the original base sits in the new canvas
    dy: int
    prompt: str = ""
    model_slug: Optional[str] = None
    mock: bool = False


@app.post("/outpaint")
def outpaint(body: OutpaintIn) -> dict:
    try:
        session = imaging.require_active(body.id)
    except KeyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    import cv2
    import numpy as np

    base = session.rgb
    H, W = base.shape[:2]
    nw, nh, dx, dy = body.new_w, body.new_h, body.dx, body.dy
    if not (nw >= W and nh >= H and 0 <= dx <= nw - W and 0 <= dy <= nh - H):
        raise HTTPException(status_code=400, detail="invalid extend bounds")

    canvas = np.zeros((nh, nw, 3), np.uint8)
    canvas[dy : dy + H, dx : dx + W] = base
    known = np.zeros((nh, nw), np.uint8)
    known[dy : dy + H, dx : dx + W] = 255
    unknown = 255 - known

    key = settings_store.get_secret("wavespeed_api_key")
    use_real = (not body.mock) and bool(key) and bool(body.model_slug)
    if use_real:
        # real outpaint = inpaint the new region with an outpaint-capable model
        try:
            slug, payload = registry.build_payload(body.model_slug, canvas, unknown, body.prompt, {})
            pid = wavespeed.submit(slug, payload, key)
            job = jobs.create(
                rgb=canvas, region=(0, 0, nw - 1, nh - 1), alpha=(known == 0).astype(np.float32),
                crop_rgb=canvas, crop_mask=unknown, prompt=body.prompt, slug=slug,
            )
            job.mode = "wavespeed"
            job.status = "polling"
            job.prediction_id = pid
            return {"job_id": job.id, "status": "polling", "width": nw, "height": nh, "dx": dx, "dy": dy}
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"outpaint submit failed: {e}")

    # mock: Telea inpaint extends the scene into the new region; base region stays exact.
    filled_bgr = cv2.inpaint(cv2.cvtColor(canvas, cv2.COLOR_RGB2BGR), unknown, 8, cv2.INPAINT_TELEA)
    filled = cv2.cvtColor(filled_bgr, cv2.COLOR_BGR2RGB)
    filled[dy : dy + H, dx : dx + W] = base  # guarantee the original region is byte-identical
    return {
        "status": "completed",
        "image_png": imaging.png_to_base64(filled, "RGB"),
        "width": nw,
        "height": nh,
        "dx": dx,
        "dy": dy,
    }


@app.post("/refine")
def refine(body: RefineIn) -> dict:
    try:
        session = imaging.require_active(body.id)
    except KeyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    mask = imaging.base64_to_gray(body.mask_png)
    if mask.shape[:2] != (session.height, session.width):
        raise HTTPException(status_code=400, detail="mask size != image size")
    alpha = _refiner.refine(session.rgb, mask)
    return {"mask_png": imaging.png_to_base64(alpha), "backend": _refiner.backend}


@app.get("/models")
def list_models() -> dict:
    return {"models": registry.public_list()}


class GenerateIn(BaseModel):
    id: str
    mask_png: str
    prompt: str = ""
    model_slug: Optional[str] = None  # model id or slug (registry resolves both)
    mock: bool = False
    pad_frac: float = 0.12
    feather: float = 2.5
    params: dict = {}
    seed: int = 0
    reference_png: Optional[str] = None  # base64 PNG of the reference image
    reference_role: Optional[str] = None  # replace | pose | style
    harmonize: Optional[dict] = None  # {on,colorMatch,relight,grainMatch,strength}


class PollIn(BaseModel):
    job_id: str


def _maybe_harmonize(base_rgb, region, result_crop, crop_mask, opts):
    if not opts or not opts.get("on"):
        return result_crop
    from app.harmonize import harmonize as _hz

    try:
        return _hz(base_rgb, region, result_crop, crop_mask, opts)
    except Exception as e:
        print(f"[harmonize] skipped: {e}")
        return result_crop


def _job_payload(job) -> dict:
    return {
        "job_id": job.id,
        "status": job.status,
        "mode": job.mode,
        "region": list(job.region),
        "result_png": job.result_png,
        "error": job.error,
    }


@app.post("/generate")
def generate(body: GenerateIn) -> dict:
    try:
        session = imaging.require_active(body.id)
    except KeyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    mask = imaging.base64_to_gray(body.mask_png)
    if mask.shape[:2] != (session.height, session.width):
        raise HTTPException(status_code=400, detail="mask size != image size")
    try:
        crop, cmask, region = compose.crop_region(session.rgb, mask, body.pad_frac)
    except ValueError:
        raise HTTPException(status_code=400, detail="empty selection")
    alpha = compose.feather_alpha(cmask, body.feather)
    job = jobs.create(
        rgb=session.rgb,
        region=region,
        alpha=alpha,
        crop_rgb=crop,
        crop_mask=cmask,
        prompt=body.prompt,
        slug=body.model_slug,
        harmonize=body.harmonize,
    )

    key = settings_store.get_secret("wavespeed_api_key")
    use_real = (not body.mock) and bool(key) and bool(body.model_slug)
    if not use_real:
        # mock path — full loop works without a key; result lands only in the selection.
        res = compose.mock_edit(crop, body.prompt, body.seed)
        res = _maybe_harmonize(session.rgb, region, res, cmask, body.harmonize)
        out = compose.composite_back(session.rgb, region, res, alpha)
        job.mode = "mock"
        job.status = "completed"
        job.result_png = imaging.png_to_base64(out, "RGB")
        return _job_payload(job)

    try:
        reference_rgb = None
        if body.reference_png:
            import base64 as _b64

            reference_rgb = imaging.load_rgb(_b64.b64decode(body.reference_png.split(",")[-1]))
        body.params.setdefault("seed", body.seed)
        slug, payload = registry.build_payload(
            body.model_slug, crop, cmask, body.prompt, body.params, reference_rgb, body.reference_role
        )
        pid = wavespeed.submit(slug, payload, key)
        job.slug = slug
        job.mode = "wavespeed"
        job.status = "polling"
        job.prediction_id = pid
        return _job_payload(job)
    except KeyError as e:
        job.status = "failed"
        job.error = str(e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        job.status = "failed"
        job.error = str(e)
        raise HTTPException(status_code=502, detail=f"submit failed: {e}")


@app.post("/poll")
def poll_generation(body: PollIn) -> dict:
    job = jobs.get(body.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job")
    if job.status in ("completed", "failed"):
        return _job_payload(job)
    key = settings_store.get_secret("wavespeed_api_key")
    if not key:
        raise HTTPException(status_code=409, detail="no WaveSpeed key")
    try:
        status, outputs, err = wavespeed.poll(job.prediction_id, key)
    except Exception as e:
        return {**_job_payload(job), "note": f"poll error (will retry): {e}"}

    if status == "completed" and outputs:
        try:
            res = imaging.load_rgb(wavespeed.download_image(outputs[0]))
            # resize to the crop, harmonize the seam, then composite
            x0, y0, x1, y1 = job.region
            import cv2 as _cv2

            res = _cv2.resize(res, (x1 - x0 + 1, y1 - y0 + 1), interpolation=_cv2.INTER_LANCZOS4)
            res = _maybe_harmonize(job.rgb, job.region, res, job.crop_mask, job.harmonize)
            out = compose.composite_back(job.rgb, job.region, res, job.alpha)
            job.status = "completed"
            job.result_png = imaging.png_to_base64(out, "RGB")
        except Exception as e:
            job.status = "failed"
            job.error = f"composite failed: {e}"
    elif status == "failed":
        job.status = "failed"
        job.error = err
    return _job_payload(job)


@app.get("/profiles")
def get_profiles() -> dict:
    return {"profiles": profile_store.list_profiles()}


class ImportProfileIn(BaseModel):
    yaml: str
    persist: bool = False


@app.post("/profiles/import")
def import_profile(body: ImportProfileIn) -> dict:
    try:
        prof, warnings = profile_store.import_profile(body.yaml, body.persist)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid profile: {e}")
    return {"profile": prof, "warnings": warnings}


class SynthIn(BaseModel):
    model_id: str
    intent: str = ""
    subject: Optional[str] = None
    reference_role: Optional[str] = None


@app.post("/synthesize")
def synthesize_prompt(body: SynthIn) -> dict:
    try:
        profile, warnings = profile_store.load(body.model_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown model")
    res = profile_synth.synthesize(profile, body.intent, body.subject, body.reference_role)
    return {**res, "warnings": warnings}


def _ui_dir() -> Path | None:
    """Locate the built frontend so the single-file app can serve its own UI.

    Frozen (PyInstaller one-file): bundled under sys._MEIPASS/web.
    Dev (repo): frontend/dist if it has been built.
    """
    candidates: list[Path] = []
    base = getattr(sys, "_MEIPASS", None)
    if base:
        candidates.append(Path(base) / "web")
    candidates.append(Path(__file__).resolve().parents[2] / "frontend" / "dist")
    for c in candidates:
        if (c / "index.html").exists():
            return c
    return None


# Serve the built UI on the same origin when present (single-file app). Mounted after the
# API routes above, so /health and friends keep priority; the mount serves everything else.
_UI = _ui_dir()
if _UI is not None:
    app.mount("/", StaticFiles(directory=str(_UI), html=True), name="ui")


def _ensure_streams() -> None:
    """Guarantee sys.stdout/stderr exist.

    A PyInstaller `--windowed` build on Windows has no console, so sys.stdout/stderr are
    None. uvicorn's log formatter (and our prints) then crash on `.isatty()` / `.write()`.
    Point any missing stream at the null device so they behave like a non-tty stream.
    """
    devnull = open(os.devnull, "w")
    if sys.stdout is None:
        sys.stdout = devnull
    if sys.stderr is None:
        sys.stderr = devnull


def _bind_port(start: int, host: str = "127.0.0.1", attempts: int = 50) -> int:
    """Find the first free port at/after `start` (fixed-with-fallback)."""
    for offset in range(attempts):
        port = start + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"no free port in [{start}, {start + attempts})")


def main() -> None:
    import uvicorn

    _ensure_streams()
    requested = int(os.environ.get(PORT_ENV, DEFAULT_PORT))
    port = _bind_port(requested)

    # Tell the Rust parent which port we actually bound. MUST be the first thing on
    # stdout and flushed immediately so the parent can read it before /health is up.
    print(f"{PORT_STDOUT_PREFIX}{port}", flush=True)
    print(f"[{APP_NAME}] {banner()}", file=sys.stderr, flush=True)

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


def serve_app() -> None:
    """All-in-one desktop launcher: serve the bundled UI and open the browser.

    This is the entrypoint for the single-file double-click app — no Tauri, no toolchains.
    """
    import threading
    import webbrowser

    import uvicorn

    _ensure_streams()
    port = _bind_port(int(os.environ.get(PORT_ENV, DEFAULT_PORT)))
    url = f"http://127.0.0.1:{port}"
    print(f"{PORT_STDOUT_PREFIX}{port}", flush=True)
    print(f"[{APP_NAME}] {banner()} — opening {url}", file=sys.stderr, flush=True)

    if _UI is None:
        print(
            f"[{APP_NAME}] WARNING: bundled UI not found; serving API only.",
            file=sys.stderr,
            flush=True,
        )

    if os.environ.get("NEUCLIP_NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
