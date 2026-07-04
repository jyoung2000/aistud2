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
GPU_APP_NAME = "Neuclip Studio GPU"

# Packages whose native CUDA libraries must be collected wholesale into a GPU build.
# torch's PyInstaller hook pulls most of it, but the nvidia-* CUDA runtime wheels
# (cublas/cudnn/cusparse/…) are data-only and need explicit collection.
_GPU_COLLECT = [
    "torch", "torchvision",
    "nvidia", "nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_runtime",
    "nvidia.cuda_nvrtc", "nvidia.cufft", "nvidia.curand", "nvidia.cusolver",
    "nvidia.cusparse", "nvidia.nccl", "nvidia.nvtx", "nvidia.cuda_cupti",
]


def _installed(pkg: str) -> bool:
    """True if `pkg` is importable. Safe for dotted submodules whose parent may be absent
    (importlib.util.find_spec raises ModuleNotFoundError in that case)."""
    import importlib.util

    try:
        return importlib.util.find_spec(pkg) is not None
    except ModuleNotFoundError:
        return False


def _verify_cuda_torch() -> None:
    """A GPU build is only meaningful if CUDA torch is installed in THIS environment —
    PyInstaller bundles whatever's importable here. Fail loudly otherwise."""
    try:
        import torch  # type: ignore
    except Exception:
        sys.exit(
            "--gpu build needs CUDA PyTorch installed in this environment first:\n"
            "  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124"
        )
    ver = getattr(torch, "version", None)
    cuda_tag = getattr(ver, "cuda", None) if ver else None
    if not cuda_tag:
        sys.exit(
            "Installed torch is the CPU build (torch.version.cuda is None). Install the CUDA "
            "wheel before a --gpu build:\n"
            "  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124"
        )
    print(f"  CUDA torch OK: torch {torch.__version__} (CUDA {cuda_tag})")


def main() -> None:
    gpu = "--gpu" in sys.argv[1:]
    name = GPU_APP_NAME if gpu else APP_NAME

    if not (DIST / "index.html").exists():
        sys.exit(
            "frontend not built — run:\n"
            "  npm --prefix frontend install\n"
            "  npm --prefix frontend run build"
        )

    # PyInstaller --add-data uses ';' on Windows, ':' elsewhere. Bundle dist as 'web' and
    # the profile schema (a data file PyInstaller won't collect on its own).
    sep = ";" if sys.platform.startswith("win") else ":"
    schema = SIDECAR / "app" / "profiles" / "schema.json"

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--windowed",                 # no console window; macOS gets a .app bundle
        "--name", name,
        "--add-data", f"{DIST}{sep}web",
        "--add-data", f"{schema}{sep}app/profiles",
        "--paths", str(SIDECAR),
    ]

    # pywebview → the app opens in a real native window (WebView2/WebKit) instead of a
    # browser tab. Optional: without it the browser fallback in serve_app() still works.
    if _installed("webview"):
        cmd += ["--collect-all", "webview"]
        print("  bundling pywebview → native desktop window")
    else:
        print("  (pywebview not installed — the app will open in the browser; "
              "`pip install pywebview` before building for a native window)")

    if gpu:
        # CUDA torch is multi-GB. --onedir keeps it a fast-launching folder (an --onefile
        # would re-extract gigabytes to temp on every double-click). Bundle CUDA wholesale.
        _verify_cuda_torch()
        cmd += ["--onedir"]
        # Only --collect-all packages that are actually installed. On Windows the CUDA libs
        # ship INSIDE the torch wheel (torch/lib/*.dll) and the standalone nvidia-* packages
        # are usually absent, so collecting a missing one would abort the build.
        for pkg in _GPU_COLLECT:
            if _installed(pkg):
                cmd += ["--collect-all", pkg]
            else:
                print(f"  (skipping --collect-all {pkg}: not installed)")
    else:
        cmd += ["--onefile"]

    cmd.append(str(SIDECAR / "app" / "desktop.py"))
    subprocess.check_call(cmd, cwd=str(SIDECAR))

    # Copy the finished app into the PROJECT ROOT so it's easy to find and double-click.
    # onefile → a single file; onedir/.app → a folder (the exe lives inside it).
    out_dir = SIDECAR / "dist"
    candidates = [
        out_dir / f"{name}.app",   # macOS bundle (windowed)
        out_dir / f"{name}.exe",   # Windows onefile
        out_dir / name,            # Linux onefile OR onedir folder (Win/Linux)
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

    if gpu:
        inner = "the .exe inside" if sys.platform.startswith("win") else "the app inside"
        print(f"\n✓ GPU build ready — double-click {inner}: {dest}")
    else:
        print(f"\n✓ Double-click this: {dest}")


if __name__ == "__main__":
    main()
