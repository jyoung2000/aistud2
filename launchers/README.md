# Opening Neuclip Studio

Two ways to run the app — pick one.

## A. The easy installers (recommended, no terminal)

Once a release has been published, download the installer for your OS from the repo's
**Releases** page and double-click it:

- **Windows** — `Neuclip-Studio_x64-setup.exe` (or `.msi`) → click through → launch from the
  Start menu.
- **macOS** — `Neuclip-Studio_x64.dmg` (Intel) or `aarch64.dmg` (Apple Silicon) → drag the
  app to Applications → open it.

These are produced automatically by `.github/workflows/release.yml` when a version tag
(e.g. `v0.1.0`) is pushed. They bundle the Python sidecar — nothing else to install.

> First open on macOS may say "unidentified developer" (the app isn't notarized yet):
> right-click the app ▸ **Open** ▸ **Open**. On Windows, SmartScreen may warn: **More info
> ▸ Run anyway**. This is normal for unsigned builds.

## B. The double-click bootstrap launchers (before a release exists)

If there's no release yet, use the launcher for your OS in this folder. It installs the
toolchains and dependencies for you and opens the app. **The first run downloads and
compiles a lot — expect 10–30 min.** Later runs open in seconds.

- **macOS** — double-click **`Start Neuclip Studio.command`**.
  First time only: right-click ▸ **Open** ▸ **Open** (clears Gatekeeper on the script).
  It installs Homebrew, Python, Node, and Rust if missing — you may be asked for your
  password.
- **Windows** — double-click **`Start Neuclip Studio.bat`**.
  It uses `winget` to install Python, Node, Rust, and the C++ build tools. After the first
  install pass it asks you to **double-click it once more** (so Windows picks up the new
  tools on `PATH`).

Both launchers are safe to re-run; they skip anything already installed.

### Requirements the launchers can't auto-fix
- **Windows:** needs `winget` (ships with Windows 10/11 "App Installer" — update it from
  the Microsoft Store if missing).
- A working internet connection for the first run.
- The full **GPU** experience (SAM 2, matting, generation) needs an NVIDIA GPU + CUDA
  PyTorch. The launcher installs the CPU-capable parts; install CUDA PyTorch per the root
  `README.md` to light up the RTX 4070.
