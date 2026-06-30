#!/bin/bash
# Neuclip Studio — build the standalone app (macOS).
# Double-click to produce "Neuclip Studio.app" in this folder: a single bundle you can copy
# to any Mac and double-click, with NO Python needed on that machine.
# This takes a minute. For everyday use, "Open Neuclip Studio.command" is faster.

cd "$(dirname "$0")" || exit 1
REPO="$(pwd)"

PY="$(command -v python3.11 || command -v python3 || command -v python)"
if [ -z "$PY" ]; then
  echo "Python 3 is required. Install it from https://www.python.org/downloads/ then try again."
  read -r -p "Press Return to close…" _; exit 1
fi

VENV="$REPO/sidecar/.venv"
[ -d "$VENV" ] || "$PY" -m venv "$VENV" || { echo "Could not create Python environment."; read -r _; exit 1; }
VPY="$VENV/bin/python"

echo "Installing build tools (first run only)…"
"$VPY" -m pip install --quiet --upgrade pip
"$VPY" -m pip install --quiet -r "$REPO/sidecar/requirements.txt" pyinstaller || { echo "Install failed."; read -r _; exit 1; }

# Rebuild the UI if it's missing and Node is available (a built UI ships in the repo).
if [ ! -f "$REPO/frontend/dist/index.html" ] && command -v npm >/dev/null 2>&1; then
  ( cd "$REPO/frontend" && npm install --no-audit --no-fund && npm run build )
fi

echo "Building the standalone app…"
"$VPY" "$REPO/sidecar/build_app.py" || { echo "Build failed."; read -r _; exit 1; }

# Reveal it in Finder.
[ -d "$REPO/Neuclip Studio.app" ] && open -R "$REPO/Neuclip Studio.app"
echo
echo "Done. Double-click 'Neuclip Studio.app' in this folder to run it."
read -r -p "Press Return to close…" _
