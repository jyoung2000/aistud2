#!/usr/bin/env python3
"""Build the single-file, double-click Neuclip Studio app.

Bundles the FastAPI sidecar AND the pre-built web UI into ONE executable. The end user
double-clicks it — no Python, Node, Rust, or compiling. On launch it starts the local
server and opens the browser to the app.

Prereqs: the frontend must be built first:
    npm --prefix frontend install
    npm --prefix frontend run build
Then:
    pip install -r sidecar/requirements.txt pyinstaller
    python sidecar/build_app.py

Output: sidecar/dist/Neuclip Studio[.exe]  (macOS: "Neuclip Studio.app")
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIDECAR = REPO / "sidecar"
DIST = REPO / "frontend" / "dist"
APP_NAME = "Neuclip Studio"


def main() -> None:
    if not (DIST / "index.html").exists():
        sys.exit(
            "frontend not built — run:\n"
            "  npm --prefix frontend install\n"
            "  npm --prefix frontend run build"
        )

    # PyInstaller --add-data uses ';' on Windows, ':' elsewhere. Bundle dist as 'web'.
    sep = ";" if sys.platform.startswith("win") else ":"
    add_data = f"{DIST}{sep}web"

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile",
        "--windowed",                 # no console window; macOS gets a .app bundle
        "--name", APP_NAME,
        "--add-data", add_data,
        "--paths", str(SIDECAR),
        str(SIDECAR / "app" / "desktop.py"),
    ]
    subprocess.check_call(cmd, cwd=str(SIDECAR))

    # Copy the finished app into the PROJECT ROOT so it's easy to find and double-click.
    out_dir = SIDECAR / "dist"
    candidates = [
        out_dir / f"{APP_NAME}.app",   # macOS bundle (windowed)
        out_dir / f"{APP_NAME}.exe",   # Windows
        out_dir / APP_NAME,            # Linux
    ]
    built = next((c for c in candidates if c.exists()), None)
    if built is None:
        sys.exit(f"build finished but no artifact found in {out_dir}")

    dest = REPO / built.name
    if dest.is_dir():
        shutil.rmtree(dest)
    elif dest.exists():
        dest.unlink()
    if built.is_dir():
        shutil.copytree(built, dest)
    else:
        shutil.copy2(built, dest)

    print(f"\n✓ Double-click this: {dest}")


if __name__ == "__main__":
    main()
