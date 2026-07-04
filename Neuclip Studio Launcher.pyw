#!/usr/bin/env python3
"""Neuclip Studio — GUI launcher (double-click me).

A windowed, Adobe-style first-run setup + launcher, pure Python stdlib (Tkinter):
  • progress bar + live status for every step (environment → packages → launch)
  • clear, human error messages (e.g. "your VPN/firewall is blocking Python's
    package server") with a RETRY button instead of a wall of pip warnings
  • repairs a broken venv (missing pip) automatically
  • then starts Neuclip Studio (native window; browser fallback)

Needs only Python 3.10+ from python.org (double-clicking a .pyw opens it with
pythonw — no console window). If Tkinter is unavailable it falls back to console
mode with the same steps.
"""
from __future__ import annotations

import os
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path

REPO = Path(__file__).resolve().parent
SIDECAR = REPO / "sidecar"
VENV = SIDECAR / ".venv"
VPY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
APP_NAME = "Neuclip Studio"

STEPS = [
    ("Checking Python environment", 10),
    ("Installing packages (first run only)", 70),
    ("Starting Neuclip Studio", 100),
]

NETWORK_HINTS = ("getaddrinfo failed", "NameResolutionError", "Failed to resolve",
                 "ConnectTimeout", "ReadTimeoutError", "Connection broken",
                 "Temporary failure in name resolution", "proxy")

NETWORK_MSG = (
    "Couldn't reach Python's package servers (pypi.org / files.pythonhosted.org).\n\n"
    "This is a network problem on this machine, not a Neuclip bug:\n"
    "  • check your internet connection\n"
    "  • DNS filter (AdGuard Home / Pi-hole)? Import 'adguard-home-allowlist.txt'\n"
    "    from this folder into its custom filtering rules\n"
    "  • VPN or firewall? Allow pypi.org and files.pythonhosted.org\n"
    "  • corporate networks may need a proxy (set HTTPS_PROXY)\n\n"
    "Fix the connection, then press Retry."
)


def _run(cmd: list[str], log) -> tuple[int, str]:
    """Run a command streaming output to the log; returns (code, full_output)."""
    p = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
    )
    out: list[str] = []
    for line in p.stdout or []:
        out.append(line)
        log(line.rstrip())
    p.wait()
    return p.returncode, "".join(out)


def _ensure_venv(log) -> None:
    """Create the venv; REPAIR one that exists without pip; recreate as a last resort."""
    def pip_ok() -> bool:
        return VPY.exists() and subprocess.run(
            [str(VPY), "-m", "pip", "--version"], capture_output=True,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        ).returncode == 0

    if not VPY.exists():
        log("creating Python environment…")
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    if not pip_ok():
        log("repairing environment (pip missing)…")
        subprocess.run([str(VPY), "-m", "ensurepip", "--upgrade", "--default-pip"],
                       capture_output=True)
    if not pip_ok():
        log("recreating environment…")
        shutil.rmtree(VENV, ignore_errors=True)
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
        subprocess.run([str(VPY), "-m", "ensurepip", "--upgrade", "--default-pip"],
                       capture_output=True)
    if not pip_ok():
        raise RuntimeError(
            "This Python can't provide pip (its 'ensurepip' module is missing).\n"
            "Install Python 3.11+ from python.org with the default options, then retry."
        )


def _install(log) -> None:
    code, out = _run(
        [str(VPY), "-m", "pip", "install", "--upgrade", "--timeout", "30", "pip"], log
    )
    code, out = _run(
        [str(VPY), "-m", "pip", "install", "--timeout", "30",
         "-r", str(SIDECAR / "requirements.txt"), "pywebview"], log
    )
    if code != 0:
        if any(h.lower() in out.lower() for h in NETWORK_HINTS):
            raise RuntimeError(NETWORK_MSG)
        raise RuntimeError("Package install failed — see the details below.")


def _launch(log) -> None:
    if os.environ.get("NEUCLIP_LAUNCHER_NO_RUN") == "1":  # test hook
        log("(launch skipped — NEUCLIP_LAUNCHER_NO_RUN=1)")
        return
    log("opening Neuclip Studio…")
    subprocess.Popen(
        [str(VPY), "-m", "app.desktop"], cwd=str(SIDECAR),
        creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
    )


def _do_all(log, progress) -> None:
    for i, (label, pct) in enumerate(STEPS):
        progress(label, pct * 0 if i == 0 else None)  # label first
        log(f"— {label}")
        if i == 0:
            _ensure_venv(log)
        elif i == 1:
            _install(log)
        else:
            _launch(log)
        progress(label, pct)


# ---------------------------------------------------------------- GUI (Tkinter)
def gui() -> int:
    import tkinter as tk
    from tkinter import ttk

    root = tk.Tk()
    root.title(f"{APP_NAME} — Setup")
    root.configure(bg="#0d0f12")
    root.geometry("560x360")
    root.resizable(False, False)

    tk.Label(root, text=APP_NAME, bg="#0d0f12", fg="#e2e8f0",
             font=("Segoe UI", 18, "bold")).pack(pady=(22, 2))
    status = tk.Label(root, text="preparing…", bg="#0d0f12", fg="#7d8694",
                      font=("Segoe UI", 10))
    status.pack()

    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except Exception:
        pass
    style.configure("N.Horizontal.TProgressbar", troughcolor="#1d222a",
                    background="#f2a33c", thickness=6, bordercolor="#1d222a",
                    lightcolor="#f2a33c", darkcolor="#f2a33c")
    bar = ttk.Progressbar(root, style="N.Horizontal.TProgressbar", length=440,
                          mode="determinate", maximum=100)
    bar.pack(pady=14)

    logbox = tk.Text(root, height=8, width=72, bg="#101319", fg="#8fa0b5",
                     font=("Consolas", 8), bd=0, highlightthickness=0, state="disabled")
    logbox.pack(padx=20)

    retry_btn = tk.Button(root, text="Retry", state="disabled", bg="#f2a33c",
                          fg="#1a160e", font=("Segoe UI", 10, "bold"), bd=0,
                          padx=18, pady=4)
    retry_btn.pack(pady=10)

    msgs: "queue.Queue[tuple[str, object]]" = queue.Queue()

    def log(line: str) -> None:
        msgs.put(("log", line))

    def progress(label: str, pct) -> None:
        msgs.put(("progress", (label, pct)))

    def worker() -> None:
        try:
            _do_all(log, progress)
            msgs.put(("done", None))
        except Exception as e:  # human message up top, details stay in the log
            msgs.put(("error", str(e)))

    def start() -> None:
        retry_btn.config(state="disabled")
        threading.Thread(target=worker, daemon=True).start()

    retry_btn.config(command=start)

    def pump() -> None:
        try:
            while True:
                kind, payload = msgs.get_nowait()
                if kind == "log":
                    logbox.config(state="normal")
                    logbox.insert("end", str(payload) + "\n")
                    logbox.see("end")
                    logbox.config(state="disabled")
                elif kind == "progress":
                    label, pct = payload  # type: ignore[misc]
                    status.config(text=str(label), fg="#7d8694")
                    if pct is not None:
                        bar["value"] = pct
                elif kind == "error":
                    status.config(text="setup hit a problem — details below", fg="#f2c078")
                    logbox.config(state="normal")
                    logbox.insert("end", "\n" + str(payload) + "\n")
                    logbox.see("end")
                    logbox.config(state="disabled")
                    retry_btn.config(state="normal")
                elif kind == "done":
                    status.config(text="Neuclip Studio is starting — you can close this window",
                                  fg="#22c55e")
                    bar["value"] = 100
                    root.after(4000, root.destroy)
        except queue.Empty:
            pass
        root.after(80, pump)

    start()
    pump()
    root.mainloop()
    return 0


def console() -> int:
    def log(line: str) -> None:
        print(f"  {line}")

    def progress(label: str, pct) -> None:
        if pct:
            print(f"[{pct:>3}%] {label}")

    try:
        _do_all(log, progress)
        return 0
    except Exception as e:
        print(f"\n[X] {e}")
        return 1


if __name__ == "__main__":
    if "--console" in sys.argv[1:]:
        sys.exit(console())
    try:
        import tkinter  # noqa: F401
    except Exception:
        sys.exit(console())
    sys.exit(gui())
