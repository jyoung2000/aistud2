"""Torch-free NVIDIA-GPU presence probe.

`device.py` reports whether *torch* sees CUDA. This module answers a different question:
is there NVIDIA GPU **hardware** on this machine at all — regardless of whether CUDA torch
is installed? The CPU build uses it to say "you have a GPU but this is the CPU build, grab
the GPU build" instead of silently running slow. It never imports torch and never raises.
"""
from __future__ import annotations

import ctypes
import shutil
import subprocess
import sys
from functools import lru_cache
from typing import Optional, Tuple


def _via_nvidia_smi() -> Optional[str]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "-L"], capture_output=True, text=True, timeout=5
        ).stdout.strip()
    except Exception:
        return None
    # "GPU 0: NVIDIA GeForce RTX 4070 (UUID: ...)"
    if out.startswith("GPU"):
        name = out.splitlines()[0]
        if ":" in name:
            name = name.split(":", 1)[1]
        return name.split("(")[0].strip() or "NVIDIA GPU"
    return None


def _driver_lib_loads() -> bool:
    """The CUDA driver library is present iff an NVIDIA driver is installed."""
    libs = (
        ["nvcuda.dll"] if sys.platform.startswith("win")
        else ["libcuda.so", "libcuda.so.1"]
    )
    for lib in libs:
        try:
            ctypes.CDLL(lib)
            return True
        except OSError:
            continue
    return False


@lru_cache(maxsize=1)
def probe() -> Tuple[bool, Optional[str]]:
    """Return (nvidia_gpu_present, gpu_name_or_None). Best-effort, never raises."""
    name = _via_nvidia_smi()
    if name:
        return True, name
    if _driver_lib_loads():
        return True, None
    return False, None


def gpu_present() -> bool:
    return probe()[0]
