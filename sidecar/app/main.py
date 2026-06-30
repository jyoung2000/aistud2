"""Neuclip Studio sidecar — FastAPI ML service.

Phase 0: boots, picks a port (fixed-with-fallback), prints the port to stdout for the
Rust parent, and serves /health. Later phases add /load /select /refine /livewire/costmap
/generate /poll.
"""
from __future__ import annotations

import os
import socket
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.constants import APP_NAME, DEFAULT_PORT, PORT_ENV, PORT_STDOUT_PREFIX
from app.device import banner, detect_device

app = FastAPI(title=f"{APP_NAME} sidecar")

# The webview origin is not fixed in dev; allow all (loopback-only service).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    d = detect_device()
    return {
        "status": "ok",
        "app": APP_NAME,
        "device": d["device"],
        "gpu_name": d["gpu_name"],
        "cuda": d["cuda"],
        "torch": d["torch"],
        "torch_version": d["torch_version"],
    }


def _bind_port(start: int, host: str = "127.0.0.1", attempts: int = 50) -> int:
    """Find the first free port at/after `start` (fixed-with-fallback)."""
    for offset in range(attempts):
        port = start + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"no free port in [{start}, {start + attempts})")


def main() -> None:
    import uvicorn

    requested = int(os.environ.get(PORT_ENV, DEFAULT_PORT))
    port = _bind_port(requested)

    # Tell the Rust parent which port we actually bound. MUST be the first thing on
    # stdout and flushed immediately so the parent can read it before /health is up.
    print(f"{PORT_STDOUT_PREFIX}{port}", flush=True)
    print(f"[{APP_NAME}] {banner()}", file=sys.stderr, flush=True)

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
