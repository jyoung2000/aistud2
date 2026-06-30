# Neuclip Studio

An AI-assisted desktop image editor. Open an image, select any element (one-click
**SAM 2**, lasso, or an editable **manual pen** path), refine the edge, then send **only
the selected crop** to a WaveSpeed image-to-image model to edit / replace / restyle it —
while the rest of the image stays byte-for-byte untouched. A per-model prompt-profile
system researches each model once and synthesizes a model-tuned prompt grounded in the
actual image.

- **Rust / Tauri 2.x** native shell (`src-tauri/`)
- **Python / FastAPI** ML sidecar (`sidecar/`)
- **React + Vite + Konva** frontend (`frontend/`)

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture, the seven cross-cutting
contracts, and per-phase status.

## Target hardware
Built for an **NVIDIA RTX 4070 (12 GB), CUDA**. All ML code detects CUDA and falls back
to CPU, but the SAM 2 / matting / generation paths are designed for the GPU.

## Prerequisites
- Python **3.11**
- Node.js LTS
- Rust stable + [Tauri 2.x prerequisites](https://tauri.app/start/prerequisites/) for your OS
- A CUDA-enabled PyTorch matching your CUDA toolkit (installed separately — see below)

## Setup

### 1. Sidecar (Python)
```bash
cd sidecar
python -m venv .venv
# Windows: .venv\Scripts\activate   |   Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt

# Install CUDA PyTorch for your toolkit (example: CUDA 12.4):
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124

# Verify the GPU is visible:
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Run the sidecar standalone (it prints the port it bound and serves `/health`):
```bash
python -m app.main
# then in another shell:  curl http://127.0.0.1:8756/health
```

### 2. Frontend
```bash
cd frontend
npm install
npm run build      # or: npm run dev  (http://localhost:5173)
```

### 3. Desktop app (dev)
With the sidecar virtualenv active so `python -m app.main` resolves, from `src-tauri/`:
```bash
cargo tauri dev
```
The Rust shell spawns the sidecar, discovers its port from stdout, polls `/health`, and
the status bar shows **"sidecar connected"** with your device badge (e.g. `RTX 4070`).
On window close the sidecar is killed (no orphans).

> **Dev sidecar binary:** `cargo tauri dev` resolves the sidecar as an `externalBin`, so
> it must exist at `src-tauri/binaries/neuclip-sidecar-<target-triple>`. Freeze it once
> (fast in Phase 0 — no torch yet) with `python sidecar/build_sidecar.py`. If it isn't
> present, the frontend still falls back to a manually-run sidecar on the default port:
> run `python -m app.main` in the activated venv, then `cargo tauri dev`.

> Phase 0 wires the dev flow using the sidecar as a Tauri `externalBin`. For a packaged
> double-click installer, freeze the sidecar first (`python sidecar/build_sidecar.py`),
> then `cargo tauri build` (Phase 9).

## Secrets
Copy `.env.example` to `.env` (local fallback) or use the in-app settings screen.
`WAVESPEED_API_KEY` and `ANTHROPIC_API_KEY` are never hardcoded.

## Build status
Phase 0 (shell & handshake) is complete. See `CLAUDE.md` for the phase checklist.
