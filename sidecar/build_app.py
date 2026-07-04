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


def _make_brand_assets(build_dir: Path) -> dict:
    """Generate the app icon (+ Windows boot splash) with PIL — no binary assets in the
    repo. Returns paths (empty dict when PIL is unavailable; everything is optional)."""
    out: dict = {}
    try:
        from PIL import Image, ImageDraw
    except Exception:
        print("  (Pillow unavailable — building without icon/splash)")
        return out
    build_dir.mkdir(parents=True, exist_ok=True)

    # icon: dark rounded square, amber selection corners around a cyan dot
    size = 256
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([8, 8, size - 8, size - 8], radius=52, fill=(13, 15, 18, 255))
    m = 62
    for cx, cy in ((m, m), (size - m, m), (m, size - m), (size - m, size - m)):
        d.rectangle([cx - 26, cy - 6, cx + 26, cy + 6], fill=(242, 163, 60, 255))
        d.rectangle([cx - 6, cy - 26, cx + 6, cy + 26], fill=(242, 163, 60, 255))
    d.ellipse([size / 2 - 34, size / 2 - 34, size / 2 + 34, size / 2 + 34], fill=(34, 211, 238, 255))
    ico = build_dir / "neuclip.ico"
    icns = build_dir / "neuclip.icns"
    png = build_dir / "neuclip.png"
    im.save(png)
    im.save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    out["png"] = png
    out["ico"] = ico
    if sys.platform == "darwin":
        try:
            im.resize((512, 512)).save(icns)
            out["icns"] = icns
        except Exception:
            pass

    # Windows-only bootloader splash: shows the INSTANT the exe runs, before Python
    # exists — the number-one "is it even starting?" fix. Closed by desktop.py.
    if sys.platform.startswith("win"):
        sp = Image.new("RGB", (440, 260), (13, 15, 18))
        ds = ImageDraw.Draw(sp)
        ds.text((40, 96), APP_NAME, fill=(226, 232, 240))
        ds.text((40, 124), "starting…", fill=(125, 134, 148))
        ds.rectangle([40, 170, 400, 174], fill=(29, 34, 42))
        ds.rectangle([40, 170, 180, 174], fill=(242, 163, 60))
        splash = build_dir / "splash.png"
        sp.save(splash)
        out["splash"] = splash
    return out


def main() -> None:
    gpu = "--gpu" in sys.argv[1:]
    onefile = "--onefile" in sys.argv[1:]  # legacy single-file (slower every launch)
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
    research = SIDECAR / "app" / "profiles" / "research"
    assets = _make_brand_assets(SIDECAR / "build_assets")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--windowed",                 # no console window; macOS gets a .app bundle
        "--name", name,
        "--add-data", f"{DIST}{sep}web",
        "--add-data", f"{schema}{sep}app/profiles",
        "--add-data", f"{research}{sep}app/profiles/research",
        "--paths", str(SIDECAR),
    ]
    if assets.get("icns") and sys.platform == "darwin":
        cmd += ["--icon", str(assets["icns"])]
    elif assets.get("ico") and sys.platform.startswith("win"):
        cmd += ["--icon", str(assets["ico"])]
    if assets.get("splash"):
        cmd += ["--splash", str(assets["splash"])]

    # pywebview → the app opens in a real native window (WebView2/WebKit) instead of a
    # browser tab. Optional: without it the browser fallback in desktop.py still works.
    if _installed("webview"):
        cmd += ["--collect-all", "webview"]
        print("  bundling pywebview → native desktop window")
    else:
        print("  (pywebview not installed — the app will open in the browser; "
              "`pip install pywebview` before building for a native window)")

    if gpu:
        # CUDA torch is multi-GB. Bundle CUDA wholesale.
        _verify_cuda_torch()
        # Only --collect-all packages that are actually installed. On Windows the CUDA libs
        # ship INSIDE the torch wheel (torch/lib/*.dll) and the standalone nvidia-* packages
        # are usually absent, so collecting a missing one would abort the build.
        for pkg in _GPU_COLLECT:
            if _installed(pkg):
                cmd += ["--collect-all", pkg]
            else:
                print(f"  (skipping --collect-all {pkg}: not installed)")

    # DEFAULT IS --onedir: a onefile exe re-extracts the whole bundle (cv2/numpy/scipy,
    # hundreds of MB) to temp on EVERY double-click and gets antivirus-rescanned each
    # time — that's 10-40 s before Python even starts. onedir launches in ~1-2 s and is
    # what the installer ships. --onefile stays available for a single portable file.
    cmd += ["--onefile"] if (onefile and not gpu) else ["--onedir"]

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
