#!/usr/bin/env python3
"""Freeze the sidecar into a single executable and place it where Tauri expects it
(`src-tauri/binaries/neuclip-sidecar-<target-triple>[.exe]`).

Used in Phase 9 packaging. Run from the repo root or the `sidecar/` dir:
    python sidecar/build_sidecar.py
Requires PyInstaller in the active environment:
    pip install pyinstaller
"""
from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIDECAR = REPO / "sidecar"
OUT = REPO / "src-tauri" / "binaries"
BIN_BASE = "neuclip-sidecar"


def target_triple() -> str:
    """Mirror Rust's host triple so Tauri's externalBin resolution finds the binary."""
    try:
        out = subprocess.check_output(["rustc", "-vV"], text=True)
        for line in out.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    except Exception:
        pass
    # Fallback guesses.
    machine = "x86_64" if platform.machine() in ("AMD64", "x86_64") else platform.machine()
    if sys.platform.startswith("win"):
        return f"{machine}-pc-windows-msvc"
    if sys.platform == "darwin":
        return f"{machine}-apple-darwin"
    return f"{machine}-unknown-linux-gnu"


def main() -> None:
    triple = target_triple()
    ext = ".exe" if sys.platform.startswith("win") else ""
    OUT.mkdir(parents=True, exist_ok=True)

    subprocess.check_call(
        [
            sys.executable, "-m", "PyInstaller",
            "--noconfirm", "--clean", "--onefile",
            "--name", BIN_BASE,
            "--paths", str(SIDECAR),
            str(SIDECAR / "app" / "main.py"),
        ],
        cwd=str(SIDECAR),
    )

    built = SIDECAR / "dist" / f"{BIN_BASE}{ext}"
    target = OUT / f"{BIN_BASE}-{triple}{ext}"
    shutil.copy2(built, target)
    print(f"sidecar -> {target}")


if __name__ == "__main__":
    main()
