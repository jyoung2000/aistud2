# Opening Neuclip Studio

## ⚡ Which one uses my GPU? (read this first)

There are two ways to run the app, and they are NOT the same:

| | Uses the NVIDIA GPU? | Needs Python? | How it looks |
|---|---|---|---|
| **`Neuclip Studio.exe`** (standalone) | ❌ **No — CPU only, always** | No | opens in your browser |
| **`Open Neuclip Studio.bat`** (launcher) | ✅ **Yes** (auto-installs CUDA PyTorch) | Yes (3.11) | opens in your browser |

**Why the `.exe` can't use your GPU:** it's a frozen, self-contained bundle — it can't carry
the multi-GB CUDA PyTorch libraries, and it can't borrow your system's Python. That's the
price of "no install needed." It's meant for CPU-only machines or for sharing the app.

**To use your RTX 4070: run `Open Neuclip Studio.bat`.** On first launch it detects the GPU
and installs CUDA PyTorch automatically (a ~2.5 GB one-time download); after that the status
badge reads **RTX 4070** and GPU work runs on the card. Both open in your browser — the browser
UI is unrelated to CPU/GPU. (A native desktop *window* is the separate Tauri build.)

> The heavy GPU **models** (SAM 2 select, BiRefNet matting, upscalers, Grounding-DINO) are
> extra optional downloads with their own weights; installing CUDA PyTorch lights up the GPU
> and the parts that ship with it, and the rest activate as you add those model weights.

---

## ⭐ The easy way — one download, double-click (no setup, CPU only)

Neuclip Studio ships as a **single self-contained app**. There is nothing to install — no
Python, Node, or Rust. It starts a small local server and opens the app in your browser.

1. Go to the repo's **Releases** page.
2. Download the file for your computer:
   - **Windows** → `Neuclip-Studio-Windows.zip` → unzip → double-click **`Neuclip Studio.exe`**
   - **Mac (Apple Silicon / M1–M4)** → `Neuclip-Studio-macOS-AppleSilicon.zip` → unzip → double-click **`Neuclip Studio.app`**
   - **Mac (Intel)** → `Neuclip-Studio-macOS-Intel.zip`
   - **Linux** → `Neuclip-Studio-Linux.zip`
3. It opens in your default browser. That's it.

> **First-open security prompt (normal for unsigned apps):**
> - **macOS:** right-click the app ▸ **Open** ▸ **Open** (only needed the first time).
> - **Windows:** if SmartScreen warns, click **More info ▸ Run anyway**.

### No release yet? Build the app once (still no Rust/Node for end users)
On any one machine with Python 3.11 + Node:
```bash
npm --prefix frontend install && npm --prefix frontend run build
pip install -r sidecar/requirements.txt pyinstaller
python sidecar/build_app.py
# -> sidecar/dist/Neuclip Studio[.exe / .app]  — copy it anywhere and double-click.
```
Or just **push a version tag** and let CI build all four downloads for you:
```bash
git tag v0.1.0 && git push origin v0.1.0   # see .github/workflows/app.yml
```

---

## 🛠️ Advanced — the full native desktop build (optional)

The single-file app above runs in your browser. If you specifically want the **native Tauri
desktop window** (and to develop the app), use the bootstrap launchers in this folder. They
install the toolchains (Python, Node, Rust, build tools) and compile the app. **This is a
real developer setup — the first run downloads and compiles a lot (10–30 min).** Most
people should use the easy way above instead.

- **macOS** — `Start Neuclip Studio.command` (right-click ▸ Open the first time).
- **Windows** — `Start Neuclip Studio.bat` (needs `winget`; re-run once after it installs tools).

Native installers (`.dmg` / `.msi`) are produced by the manual **"Native installers
(Tauri)"** workflow in the Actions tab.

---

### GPU note
The full ML experience (SAM 2 select, edge matting, generation) needs an NVIDIA GPU + CUDA
PyTorch on the machine running the app. Install it per the root `README.md`. The downloads
above open the app UI everywhere; GPU features light up where CUDA is available.
