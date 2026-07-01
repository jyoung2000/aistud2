# Opening Neuclip Studio

## ⚡ Which one uses my GPU? (read this first)

There are three ways to run the app:

| | Uses the NVIDIA GPU? | Needs Python? | Size | How it looks |
|---|---|---|---|---|
| **`Neuclip Studio GPU`** (GPU build) | ✅ **Yes — CUDA on double-click** | No | ~4–5 GB (a folder) | opens in your browser |
| **`Neuclip Studio.exe`** (standard) | ❌ No — CPU only | No | ~150 MB (one file) | opens in your browser |
| **`Open Neuclip Studio.bat`** (launcher) | ✅ Yes (auto-installs CUDA PyTorch) | Yes (3.11) | small | opens in your browser |

**For your RTX 4070, download the GPU build.** It bundles CUDA PyTorch, so double-clicking the
`.exe` inside the **`Neuclip Studio GPU`** folder activates the GPU automatically — no Python, no
install, no first-run download. The status badge reads **RTX 4070**. It ships as a folder (not a
single file) so it launches fast instead of unpacking several GB every time.

**Why the small standard `.exe` is CPU-only:** it's a single self-contained file and can't carry
the multi-GB CUDA libraries. It's meant for CPU machines, quick sharing, or when download size
matters. Run it on an NVIDIA machine and the app detects the idle GPU and points you to the GPU
build.

The **launcher** (`Open Neuclip Studio.bat`) is the small-download GPU path: on first launch it
detects the GPU and installs CUDA PyTorch (~2.5 GB one-time) into a local environment. All three
open in your browser — the browser UI is unrelated to CPU/GPU. (A native desktop *window* is the
separate Tauri build.)

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
**GPU build (NVIDIA, activates CUDA on double-click):** the easiest way is to double-click
**`Build Standalone App.bat`** — after the CPU build it detects an NVIDIA GPU and **automatically**
builds the GPU version too (installs CUDA PyTorch, then builds — no prompt). Or do it by hand:
```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
python sidecar/build_app.py --gpu
# -> "Neuclip Studio GPU" folder — double-click the .exe inside it. CUDA is bundled.
```
Or just **push a version tag** and let CI build all the downloads for you (including the Windows
GPU build):
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
