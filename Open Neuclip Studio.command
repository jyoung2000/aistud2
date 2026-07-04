#!/bin/bash
# Neuclip Studio — double-click to open (macOS).
# First time only: right-click this file ▸ Open ▸ Open (clears Gatekeeper).
# Needs only Python 3. It opens the app in your web browser.

cd "$(dirname "$0")" || exit 1
REPO="$(pwd)"

PY="$(command -v python3.11 || command -v python3 || command -v python)"
if [ -z "$PY" ]; then
  echo "Python 3 is required. Install it from https://www.python.org/downloads/ then double-click again."
  read -r -p "Press Return to close…" _; exit 1
fi

VENV="$REPO/sidecar/.venv"
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV" || { echo "Could not create Python environment."; read -r _; exit 1; }
VPY="$VENV/bin/python"

# repair a venv that exists without pip; recreate it if that fails
if ! "$VPY" -m pip --version >/dev/null 2>&1; then
  "$VPY" -m ensurepip --upgrade --default-pip >/dev/null 2>&1
fi
if ! "$VPY" -m pip --version >/dev/null 2>&1; then
  echo "Recreating Python environment (pip missing)…"
  rm -rf "$VENV"
  "$PY" -m venv "$VENV" || { echo "Could not create Python environment."; read -r _; exit 1; }
  "$VPY" -m ensurepip --upgrade --default-pip >/dev/null 2>&1
fi
"$VPY" -m pip --version >/dev/null 2>&1 || {
  echo "This Python can't provide pip (ensurepip missing). Install Python 3.11+ from python.org and retry."
  read -r _; exit 1
}

echo "Preparing Neuclip Studio (first run only — this installs a few packages)…"
"$VPY" -m pip install --quiet --upgrade pip
"$VPY" -m pip install --quiet -r "$REPO/sidecar/requirements.txt" pywebview || { echo "Dependency install failed."; read -r _; exit 1; }

# GPU: auto-install CUDA PyTorch on machines with an NVIDIA GPU (Linux desktops).
if command -v nvidia-smi >/dev/null 2>&1; then
  if ! "$VPY" -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" >/dev/null 2>&1; then
    echo "NVIDIA GPU detected — installing CUDA PyTorch (large one-time download)…"
    "$VPY" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
    "$VPY" -c "import torch; print('  GPU ready:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CUDA not available')"
  fi
fi
# (Apple Silicon Macs have no CUDA; the app runs on CPU there.)

# Build the UI only if it's missing AND Node is available (a built UI ships in the repo).
if [ ! -f "$REPO/frontend/dist/index.html" ] && command -v npm >/dev/null 2>&1; then
  ( cd "$REPO/frontend" && npm install --no-audit --no-fund && npm run build )
fi

echo "Opening Neuclip Studio in your browser…"
cd "$REPO/sidecar"
exec "$VPY" -m app.desktop
