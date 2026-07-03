"""Test bootstrap: isolate the config dir so a developer's local ~/.neuclip user layers
and feedback counters can never change golden outputs, and make `app` importable when
pytest runs from the repo root."""
import os
import sys
import tempfile
from pathlib import Path

# isolated, empty config dir BEFORE any app import reads it
os.environ["NEUCLIP_CONFIG_DIR"] = tempfile.mkdtemp(prefix="neuclip-test-")

sys.path.insert(0, str(Path(__file__).parent.parent))  # sidecar/ on the path
