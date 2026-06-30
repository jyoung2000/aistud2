"""Entry point for the single-file double-click app (PyInstaller target).

Starts the sidecar, serves the bundled UI, and opens the browser. No Tauri, Node, or Rust.
"""
from app.main import serve_app

if __name__ == "__main__":
    serve_app()
