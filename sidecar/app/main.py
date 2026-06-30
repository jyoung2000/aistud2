"""Neuclip Studio sidecar — FastAPI ML service.

Phase 0: boots, picks a port (fixed-with-fallback), prints the port to stdout for the
Rust parent, and serves /health. Later phases add /load /select /refine /livewire/costmap
/generate /poll.
"""
from __future__ import annotations

import os
import socket
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

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


def _ui_dir() -> Path | None:
    """Locate the built frontend so the single-file app can serve its own UI.

    Frozen (PyInstaller one-file): bundled under sys._MEIPASS/web.
    Dev (repo): frontend/dist if it has been built.
    """
    candidates: list[Path] = []
    base = getattr(sys, "_MEIPASS", None)
    if base:
        candidates.append(Path(base) / "web")
    candidates.append(Path(__file__).resolve().parents[2] / "frontend" / "dist")
    for c in candidates:
        if (c / "index.html").exists():
            return c
    return None


# Serve the built UI on the same origin when present (single-file app). Mounted after the
# API routes above, so /health and friends keep priority; the mount serves everything else.
_UI = _ui_dir()
if _UI is not None:
    app.mount("/", StaticFiles(directory=str(_UI), html=True), name="ui")


def _ensure_streams() -> None:
    """Guarantee sys.stdout/stderr exist.

    A PyInstaller `--windowed` build on Windows has no console, so sys.stdout/stderr are
    None. uvicorn's log formatter (and our prints) then crash on `.isatty()` / `.write()`.
    Point any missing stream at the null device so they behave like a non-tty stream.
    """
    devnull = open(os.devnull, "w")
    if sys.stdout is None:
        sys.stdout = devnull
    if sys.stderr is None:
        sys.stderr = devnull


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

    _ensure_streams()
    requested = int(os.environ.get(PORT_ENV, DEFAULT_PORT))
    port = _bind_port(requested)

    # Tell the Rust parent which port we actually bound. MUST be the first thing on
    # stdout and flushed immediately so the parent can read it before /health is up.
    print(f"{PORT_STDOUT_PREFIX}{port}", flush=True)
    print(f"[{APP_NAME}] {banner()}", file=sys.stderr, flush=True)

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


def serve_app() -> None:
    """All-in-one desktop launcher: serve the bundled UI and open the browser.

    This is the entrypoint for the single-file double-click app — no Tauri, no toolchains.
    """
    import threading
    import webbrowser

    import uvicorn

    _ensure_streams()
    port = _bind_port(int(os.environ.get(PORT_ENV, DEFAULT_PORT)))
    url = f"http://127.0.0.1:{port}"
    print(f"{PORT_STDOUT_PREFIX}{port}", flush=True)
    print(f"[{APP_NAME}] {banner()} — opening {url}", file=sys.stderr, flush=True)

    if _UI is None:
        print(
            f"[{APP_NAME}] WARNING: bundled UI not found; serving API only.",
            file=sys.stderr,
            flush=True,
        )

    if os.environ.get("NEUCLIP_NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
