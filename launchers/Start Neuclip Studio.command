#!/bin/bash
# Neuclip Studio — macOS double-click launcher.
# Double-click in Finder (first time: right-click ▸ Open to clear Gatekeeper).
# First run installs everything (Homebrew, Python, Node, Rust, deps) — this takes a while.
# Later runs just open the app.

set -u
cd "$(dirname "$0")/.." || exit 1
REPO="$(pwd)"

say()  { printf "\n\033[1;33m▸ %s\033[0m\n" "$1"; }
ok()   { printf "\033[1;32m✓ %s\033[0m\n" "$1"; }
die()  { printf "\n\033[1;31m✗ %s\033[0m\n" "$1"; echo; read -r -p "Press Return to close…" _; exit 1; }

echo "========================================"
echo "   Neuclip Studio launcher (macOS)"
echo "========================================"

# --- Homebrew ---------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew (you may be asked for your password)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || die "Homebrew install failed."
fi
# Put brew on PATH for this session (Apple Silicon + Intel locations).
for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$p" ] && eval "$("$p" shellenv)"
done
command -v brew >/dev/null 2>&1 || die "Homebrew not on PATH."
ok "Homebrew ready"

# --- toolchains -------------------------------------------------------------
command -v python3.11 >/dev/null 2>&1 || { say "Installing Python 3.11…"; brew install python@3.11 || die "python install failed"; }
command -v node       >/dev/null 2>&1 || { say "Installing Node.js…";     brew install node        || die "node install failed"; }
if ! command -v cargo >/dev/null 2>&1; then
  say "Installing Rust…"
  brew install rustup-init >/dev/null 2>&1 || true
  rustup-init -y --no-modify-path >/dev/null 2>&1 || brew install rust || die "rust install failed"
fi
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
command -v cargo >/dev/null 2>&1 || die "cargo not on PATH."
ok "Toolchains ready"

PY="$(command -v python3.11 || command -v python3)"

# --- Tauri CLI --------------------------------------------------------------
if ! cargo tauri --version >/dev/null 2>&1; then
  say "Installing Tauri CLI (one-time, compiles — be patient)…"
  cargo install tauri-cli --version "^2" --locked || die "tauri-cli install failed"
fi
ok "Tauri CLI ready"

# --- sidecar (Python) -------------------------------------------------------
if [ ! -d "$REPO/sidecar/.venv" ]; then
  say "Creating Python environment…"
  "$PY" -m venv "$REPO/sidecar/.venv" || die "venv create failed"
fi
VENV_PY="$REPO/sidecar/.venv/bin/python"
say "Installing sidecar dependencies…"
"$VENV_PY" -m pip install --quiet --upgrade pip
"$VENV_PY" -m pip install --quiet -r "$REPO/sidecar/requirements.txt" pyinstaller || die "pip install failed"
ok "Sidecar ready"

# --- frontend ---------------------------------------------------------------
if [ ! -d "$REPO/frontend/node_modules" ]; then
  say "Installing frontend dependencies…"
  ( cd "$REPO/frontend" && npm install --no-audit --no-fund ) || die "npm install failed"
fi
ok "Frontend ready"

# --- freeze the sidecar so Tauri's externalBin resolves ---------------------
TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
if [ ! -x "$REPO/src-tauri/binaries/neuclip-sidecar-$TRIPLE" ]; then
  say "Packaging the sidecar (one-time)…"
  ( cd "$REPO/sidecar" && "$VENV_PY" build_sidecar.py ) || die "sidecar packaging failed"
fi
ok "Sidecar packaged"

# --- launch -----------------------------------------------------------------
say "Opening Neuclip Studio… (first launch compiles the app — this can take several minutes)"
cd "$REPO/src-tauri" || die "missing src-tauri"
cargo tauri dev || die "app exited with an error."
