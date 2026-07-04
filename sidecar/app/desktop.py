"""Entry point for the double-click Neuclip Studio app (PyInstaller target).

Boot strategy — the window must appear IMMEDIATELY:
the heavy Python stack (numpy/cv2/fastapi ≈ 5–10 s cold) is imported on a background
thread while the main thread opens the native window right away with a branded loading
screen. When the engine answers /health the window navigates to the real UI. The browser
tab remains the fallback when pywebview is unavailable (NEUCLIP_BROWSER=1 forces it;
NEUCLIP_NO_BROWSER=1 = headless).

A `.neuclip` project passed as argv (double-clicked file via the installer's file
association) is exposed through /bootstrap so the UI opens it on load.
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import urllib.request

# Light import — constants only (no numpy/cv2/fastapi here; keep the window instant).
from app.constants import APP_NAME, DEFAULT_PORT, PORT_ENV, PORT_STDOUT_PREFIX

_SPLASH_HTML = f"""<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{{height:100%;margin:0;background:#0d0f12;color:#e2e8f0;
    font:14px ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center}}
  .card{{text-align:center}}
  .name{{font-size:22px;font-weight:700;letter-spacing:.4px;margin-bottom:6px}}
  .sub{{color:#7d8694;font-size:12px;margin-bottom:22px}}
  .bar{{width:260px;height:4px;border-radius:2px;background:#1d222a;overflow:hidden;margin:0 auto}}
  .fill{{width:40%;height:100%;border-radius:2px;background:#f2a33c;
    animation:slide 1.1s ease-in-out infinite}}
  @keyframes slide{{0%{{transform:translateX(-100%)}}100%{{transform:translateX(360%)}}}}
  .step{{color:#5c6473;font-size:11px;margin-top:12px}}
</style></head><body><div class="card">
  <div class="name">{APP_NAME}</div>
  <div class="sub">AI-assisted image studio</div>
  <div class="bar"><div class="fill"></div></div>
  <div class="step">starting the engine…</div>
</div></body></html>"""

_ERROR_HTML = f"""<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{{height:100%;margin:0;background:#0d0f12;color:#e2e8f0;
    font:13px ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center}}
</style></head><body><div style="text-align:center;max-width:420px">
  <div style="font-size:18px;font-weight:700;margin-bottom:8px">Couldn't start the engine</div>
  <div style="color:#9aa4b2;line-height:1.6">{APP_NAME}'s local engine didn't come up in time.
  Close this window and try again — if it keeps happening, launch from a terminal to see
  the error output.</div>
</div></body></html>"""


def _say(msg: str) -> None:
    """Console-less (windowed) builds have no stdout — never let a print crash boot."""
    try:
        print(msg, flush=True)
    except Exception:
        pass


def _pick_port() -> int:
    start = int(os.environ.get(PORT_ENV, DEFAULT_PORT))
    for port in range(start, start + 50):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
            return port
        except OSError:
            continue
    return start


def _close_pyi_splash() -> None:
    """Close the PyInstaller boot splash (shown before Python even started), if present."""
    try:  # pragma: no cover - only exists inside a --splash build
        import pyi_splash  # type: ignore

        pyi_splash.close()
    except Exception:
        pass


def _health_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def _run_server(port: int) -> None:
    """Import the heavy stack + serve. Runs on a daemon thread (or the main thread in
    browser/headless mode)."""
    import uvicorn  # noqa: WPS433

    from app.main import _ensure_streams
    from app.main import app as fastapi_app  # ← numpy/cv2/fastapi import cost lives here

    _ensure_streams()  # windowed builds have no console; give logging real streams
    uvicorn.run(fastapi_app, host="127.0.0.1", port=port, log_level="warning")


def main() -> None:
    # a double-clicked .neuclip project (installer file association) rides an env var
    # that /bootstrap serves to the UI once it loads
    for a in sys.argv[1:]:
        if a.lower().endswith(".neuclip") and os.path.isfile(a):
            os.environ["NEUCLIP_OPEN_PROJECT"] = os.path.abspath(a)
            break

    port = _pick_port()
    os.environ[PORT_ENV] = str(port)  # the server binds exactly this port
    url = f"http://127.0.0.1:{port}"
    _say(f"{PORT_STDOUT_PREFIX}{port}")

    headless = os.environ.get("NEUCLIP_NO_BROWSER") == "1"
    force_browser = os.environ.get("NEUCLIP_BROWSER") == "1"

    if headless:
        _close_pyi_splash()
        _run_server(port)  # blocks
        return

    # --- native window path: window NOW, engine loads behind it -------------------
    if not force_browser:
        try:
            import webview  # type: ignore

            threading.Thread(target=_run_server, args=(port,), daemon=True).start()
            window = webview.create_window(
                APP_NAME, html=_SPLASH_HTML, width=1440, height=900,
                min_size=(1024, 640), background_color="#0d0f12",
            )

            def _navigate_when_ready() -> None:
                deadline = time.time() + 120  # cold AV-scanned first launch can be slow
                while time.time() < deadline:
                    if _health_ok(url):
                        window.load_url(url)
                        return
                    time.sleep(0.25)
                window.load_html(_ERROR_HTML)

            threading.Thread(target=_navigate_when_ready, daemon=True).start()
            _close_pyi_splash()  # the real window is up — retire the bootloader splash
            webview.start()  # blocks until the window closes; daemon server dies with us
            return
        except Exception as e:
            _say(f"[{APP_NAME}] native window unavailable ({e}); opening the browser.")

    # --- browser fallback ----------------------------------------------------------
    import webbrowser

    def _open_when_ready() -> None:
        deadline = time.time() + 120
        while time.time() < deadline:
            if _health_ok(url):
                webbrowser.open(url)
                return
            time.sleep(0.25)

    threading.Thread(target=_open_when_ready, daemon=True).start()
    _close_pyi_splash()
    _run_server(port)  # blocks


if __name__ == "__main__":
    main()
