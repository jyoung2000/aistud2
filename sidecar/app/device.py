"""GPU / device detection.

torch is an OPTIONAL import in Phase 0 so /health works before the heavy ML stack is
installed. On the target RTX 4070 this reports cuda + the GPU name; in the headless
build container (no torch / no GPU) it degrades to cpu without raising.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Optional, TypedDict


class DeviceInfo(TypedDict):
    device: str           # "cuda" | "cpu"
    gpu_name: Optional[str]
    cuda: bool
    torch: bool
    torch_version: Optional[str]
    gpu_present: bool     # NVIDIA hardware exists (even if CUDA torch isn't loaded)


@lru_cache(maxsize=1)
def detect_device() -> DeviceInfo:
    from app.gpu_probe import probe

    hw_present, hw_name = probe()
    try:
        import torch  # type: ignore
    except Exception:
        return DeviceInfo(
            device="cpu", gpu_name=None, cuda=False, torch=False, torch_version=None,
            gpu_present=hw_present,
        )

    cuda = bool(torch.cuda.is_available())
    gpu_name = torch.cuda.get_device_name(0) if cuda else hw_name
    return DeviceInfo(
        device="cuda" if cuda else "cpu",
        gpu_name=gpu_name,
        cuda=cuda,
        torch=True,
        torch_version=getattr(torch, "__version__", None),
        gpu_present=hw_present or cuda,
    )


def banner() -> str:
    d = detect_device()
    if d["cuda"]:
        return f"GPU: {d['gpu_name']} (CUDA, torch {d['torch_version']})"
    if d["gpu_present"]:
        where = f" ({d['gpu_name']})" if d["gpu_name"] else ""
        return f"CPU build on a GPU machine{where} — download the GPU build to activate CUDA"
    if d["torch"]:
        return f"CPU only (torch {d['torch_version']} — no CUDA device)"
    return "CPU only (torch not installed)"
