@echo off
REM Neuclip Studio - double-click to open (Windows).
REM Needs only Python 3. Opens a native window (browser fallback).
setlocal
title Neuclip Studio
cd /d "%~dp0"
set "REPO=%CD%"
set "VENV=%REPO%\sidecar\.venv"
set "VPY=%VENV%\Scripts\python.exe"

REM --- find a real Python (the Microsoft Store "python" stub is not runnable) -----
where python >nul 2>&1
if errorlevel 1 goto :nopython
python -c "import sys; sys.exit(0)" >nul 2>&1
if errorlevel 1 goto :nopython

REM --- create the venv, and REPAIR it if it exists without pip --------------------
if not exist "%VPY%" (
  echo Creating Python environment...
  python -m venv "%VENV%" || (echo Could not create Python environment. & pause & exit /b 1)
)
"%VPY%" -m pip --version >nul 2>&1
if errorlevel 1 (
  echo Repairing Python environment ^(pip missing^)...
  "%VPY%" -m ensurepip --upgrade --default-pip >nul 2>&1
)
"%VPY%" -m pip --version >nul 2>&1
if errorlevel 1 (
  echo Recreating Python environment...
  rmdir /s /q "%VENV%"
  python -m venv "%VENV%" || (echo Could not create Python environment. & pause & exit /b 1)
  "%VPY%" -m ensurepip --upgrade --default-pip >nul 2>&1
)
"%VPY%" -m pip --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo [X] This Python can't provide pip ^(its "ensurepip" module is missing^).
  echo     Please install Python 3.11+ from https://www.python.org/downloads/
  echo     with the DEFAULT options ^(tick "Add Python to PATH"^), then run this again.
  pause & exit /b 1
)

echo Preparing Neuclip Studio (first run only - this installs a few packages)...
"%VPY%" -m pip install --quiet --upgrade pip
"%VPY%" -m pip install --quiet -r "%REPO%\sidecar\requirements.txt" pywebview || (echo Dependency install failed. Scroll up for the error. & pause & exit /b 1)

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

echo Opening Neuclip Studio...
cd /d "%REPO%\sidecar"
"%VPY%" -m app.desktop
exit /b 0

:nopython
echo Python 3 is required ^(the Microsoft Store "python" shortcut doesn't count^).
echo Install it from https://www.python.org/downloads/ - during install, tick
echo "Add Python to PATH" - then double-click this file again.
pause & exit /b 1
