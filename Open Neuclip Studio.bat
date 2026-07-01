@echo off
REM Neuclip Studio - double-click to open (Windows).
REM Needs only Python 3. It opens the app in your web browser.
setlocal
title Neuclip Studio
cd /d "%~dp0"
set "REPO=%CD%"

where python >nul 2>&1
if errorlevel 1 (
  echo Python 3 is required. Install it from https://www.python.org/downloads/
  echo During install, tick "Add Python to PATH", then double-click this file again.
  pause & exit /b 1
)

if not exist "%REPO%\sidecar\.venv" (
  python -m venv "%REPO%\sidecar\.venv" || (echo Could not create Python environment. & pause & exit /b 1)
)
set "VPY=%REPO%\sidecar\.venv\Scripts\python.exe"

echo Preparing Neuclip Studio (first run only - this installs a few packages)...
"%VPY%" -m pip install --quiet --upgrade pip
"%VPY%" -m pip install --quiet -r "%REPO%\sidecar\requirements.txt" || (echo Dependency install failed. & pause & exit /b 1)

REM --- GPU: auto-install CUDA PyTorch when an NVIDIA GPU is present -----------
where nvidia-smi >nul 2>&1
if not errorlevel 1 (
  "%VPY%" -c "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>&1
  if errorlevel 1 (
    echo.
    echo NVIDIA GPU detected - installing CUDA PyTorch for GPU acceleration.
    echo This is a large one-time download ^(~2.5 GB^); please wait...
    "%VPY%" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
    "%VPY%" -c "import torch; print('  GPU ready:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CUDA not available')"
  ) else (
    echo GPU: CUDA PyTorch already installed.
  )
) else (
  echo No NVIDIA GPU detected - running on CPU.
)

REM Build the UI only if missing AND Node is available (a built UI ships in the repo).
if not exist "%REPO%\frontend\dist\index.html" (
  where npm >nul 2>&1 && ( pushd "%REPO%\frontend" && call npm install --no-audit --no-fund && call npm run build && popd )
)

echo Opening Neuclip Studio in your browser...
cd /d "%REPO%\sidecar"
"%VPY%" -m app.desktop
