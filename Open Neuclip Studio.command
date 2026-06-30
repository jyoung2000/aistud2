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
[ -d "$VENV" ] || "$PY" -m venv "$VENV" || { echo "Could not create Python environment."; read -r _; exit 1; }
VPY="$VENV/bin/python"

echo "Preparing Neuclip Studio (first run only — this installs a few packages)…"
"$VPY" -m pip install --quiet --upgrade pip
"$VPY" -m pip install --quiet -r "$REPO/sidecar/requirements.txt" || { echo "Dependency install failed."; read -r _; exit 1; }

# Build the UI only if it's missing AND Node is available (a built UI ships in the repo).
if [ ! -f "$REPO/frontend/dist/index.html" ] && command -v npm >/dev/null 2>&1; then
  ( cd "$REPO/frontend" && npm install --no-audit --no-fund && npm run build )
fi

echo "Opening Neuclip Studio in your browser…"
cd "$REPO/sidecar"
exec "$VPY" -m app.desktop
