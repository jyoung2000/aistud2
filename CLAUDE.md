# Neuclip Studio — Build Contract & Decisions

> AI-assisted "Photoshop": open an image, select any element (SAM 2 / lasso / editable
> manual pen), refine the edge, then send **only the selected crop** to a WaveSpeed
> image-to-image model to edit/replace/restyle it while the rest of the image stays
> byte-for-byte untouched. A per-model prompt-profile system researches each model once
> and synthesizes a model-tuned prompt grounded in the actual image.

**App name:** "Neuclip Studio" — single renameable constant (`APP_NAME`).
Frontend: `frontend/src/constants.ts`. Sidecar: `sidecar/app/constants.py`.

## Architecture
- **Rust / Tauri 2.x** (`src-tauri/`) — native window + packaging; spawns/health-checks/
  shuts down the Python sidecar (no orphans).
- **Python / FastAPI sidecar** (`sidecar/`) — ALL ML (SAM 2, BiRefNet, live-wire cost map,
  compositing, WaveSpeed client, prompt agent).
- **React + Vite + Konva** (`frontend/`) — runs in the Tauri webview.

## Target / build environment (IMPORTANT)
- **Target machine:** user's desktop, **NVIDIA RTX 4070 (12 GB), CUDA**. This is where
  GPU + desktop-window checkpoints are verified.
- **This build container:** headless Ubuntu 24.04, **no GPU, no display**. Used to author
  code and verify the CPU-verifiable paths (sidecar boots, `/health`, frontend builds,
  Rust compiles). All ML code MUST detect CUDA and fall back to CPU so it runs anywhere.
- Python **3.11**. Node LTS. Rust stable. Tauri 2.x.
- Secrets (`WAVESPEED_API_KEY`, `ANTHROPIC_API_KEY`) come from the settings screen / OS
  keychain with a local-config fallback. **Never hardcode.** `.env.example` is shipped.

## Cross-cutting contracts (honor in EVERY phase)
1. **Two coordinate spaces, never conflated.** *View space* = Konva `Stage` transform
   (scale/position); zoom/pan touch ONLY this and are non-destructive. *Image space* =
   original pixel grid; every selection artifact (SAM points, lasso vertices, manual
   anchors, live-wire path, mask buffer) is stored in image-space. `screenToImage` /
   `imageToScreen` in `frontend/src/canvas/coords.ts`. Same pixel → identical image-space
   coord at any zoom.
2. **One shared mask buffer + boolean ops.** All select tools write a single image-space
   mask via a modifier-chosen op: none = **replace**, Shift = **add**, Alt = **subtract**,
   Shift+Alt = **intersect**. Marching ants, edge-refine, crop-bbox, cost card all read
   this one buffer. (`frontend/src/canvas/maskBuffer.ts`)
3. **Crop-only send.** Generation ALWAYS sends a padded crop of the selection, never the
   full frame. Composite the result back through the feathered alpha; untouched pixels
   stay bit-identical. (`sidecar/app/compose.py`)
4. **Async everything.** Encode, matting, live-wire, polling, LLM calls never block UI.
5. **Color logic.** Cyan = everything *selection*; amber = everything *AI-generation*.
6. **Don't guess WaveSpeed slugs/schemas.** Pull each model's exact endpoint path + input
   schema from its model-card "API" tab; encode it in that adapter. Confirmed pattern:
   `POST https://api.wavespeed.ai/api/v3/wavespeed-ai/{slug}` with
   `Authorization: Bearer <key>` → prediction id → poll until `status=="completed"` →
   read `data.outputs[0]`. Confirmed slug: `wavespeed-ai/qwen-image/edit-2511`.
7. **Imported prompt profiles are untrusted data** (see Phase 8 safety).

## Sidecar API surface (target)
`/health` `/load` `/select` `/refine` `/livewire/costmap` `/generate` `/poll`

## Sidecar <-> Tauri handshake (Phase 0, IMPLEMENTED)
- Sidecar binds a port: tries `NEUCLIP_SIDECAR_PORT` (default 8756); on conflict it
  increments and, once bound, **prints `NEUCLIP_SIDECAR_PORT=<port>` to stdout** so the
  Rust parent can discover it (fixed-with-fallback + sidecar-prints-port).
- Rust spawns the sidecar as a Tauri `externalBin`, reads stdout for the port line, polls
  `GET /health` until ready, exposes the port to the frontend via a Tauri command
  (`sidecar_port`), and **kills the child on window close** (no orphans).
- `/health` returns `{ status, app, device, gpu_name, cuda, torch }`.

## Conventions / decisions log
- **Device selection** (`sidecar/app/device.py`): `cuda` if `torch.cuda.is_available()`
  else `cpu`. `gpu_name` from `torch.cuda.get_device_name(0)` when present. torch is
  treated as an OPTIONAL import in Phase 0 so `/health` works even before the heavy ML
  stack is installed (reports `torch: false`).
- **Status bar badge** shows the real device reported by `/health` (e.g. "RTX 4070" on
  target, "CPU" in the headless container) — never hardcoded.
- Ports/paths/secrets via env with sane fallbacks; nothing hardcoded.

## Phase status
- [x] **Phase 0** — Shell & handshake (sidecar `/health`, port discovery, Tauri spawn,
      frontend status bar, clean shutdown). Verified here: sidecar boots + `/health` on
      CPU, frontend builds. Verify on 4070: GPU name in badge, desktop window, no orphan.
- [ ] Phase 1 — Canvas & coordinate core
- [ ] Phase 2 — Navigation (zoom & pan)
- [ ] Phase 3 — Smart select (SAM 2) + refine
- [ ] Phase 4 — Lasso tools (freehand / polygonal / magnetic live-wire)
- [ ] Phase 5 — Manual editable selection (pen-grade)
- [ ] Phase 6 — Edit pipeline: crop-composite + first model
- [ ] Phase 7 — Model registry & adapters
- [ ] Phase 8 — Model prompt profiles & synthesis
- [ ] Phase 9 — Finish & package
