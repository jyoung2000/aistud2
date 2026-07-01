@echo off
REM Neuclip Studio - build the standalone app (Windows).
REM Produces "Neuclip Studio.exe" (CPU, one file) in this folder, and on an NVIDIA machine
REM automatically also builds "Neuclip Studio GPU" (a folder) that uses your GPU on double-click.
REM Copy either to any PC and double-click - NO Python needed on that machine.
REM This takes a minute (CPU) / several minutes (GPU). For everyday use, "Open Neuclip Studio.bat" is faster.
setlocal
title Build Neuclip Studio
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

echo Installing build tools (first run only)...
"%VPY%" -m pip install --quiet --upgrade pip
"%VPY%" -m pip install --quiet -r "%REPO%\sidecar\requirements.txt" pyinstaller || (echo Install failed. & pause & exit /b 1)

REM Rebuild the UI if it's missing and Node is available (a built UI ships in the repo).
if not exist "%REPO%\frontend\dist\index.html" (
  where npm >nul 2>&1 && ( pushd "%REPO%\frontend" && call npm install --no-audit --no-fund && call npm run build && popd )
)

echo Building the standalone CPU app...
"%VPY%" "%REPO%\sidecar\build_app.py" || (echo Build failed. & pause & exit /b 1)

REM --- GPU build (NVIDIA - bundles CUDA PyTorch, uses the GPU on double-click) ---------------
REM Built automatically whenever an NVIDIA GPU is present. No prompt.
where nvidia-smi >nul 2>&1
if errorlevel 1 goto :done
echo.
echo ============================================================================
echo   NVIDIA GPU detected - building the GPU version automatically.
echo   This is LARGE: a ~2.5 GB one-time CUDA PyTorch download + a ~4-5 GB
echo   output folder ("Neuclip Studio GPU"). It takes several minutes.
echo   (To skip it, run this from a machine without an NVIDIA GPU / driver.)
echo ============================================================================
echo.
echo Installing CUDA PyTorch (one-time, large - please wait)...
"%VPY%" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124 || (echo CUDA PyTorch install failed. & pause & exit /b 1)
echo Building the GPU app (this takes several minutes)...
"%VPY%" "%REPO%\sidecar\build_app.py" --gpu || (echo GPU build failed. & pause & exit /b 1)

:done
echo.
if exist "%REPO%\Neuclip Studio GPU" (
  echo Done. For your NVIDIA GPU, open the "Neuclip Studio GPU" folder and double-click
  echo the .exe inside it. ^(The plain "Neuclip Studio.exe" is the small CPU-only build.^)
  explorer /select,"%REPO%\Neuclip Studio GPU"
) else (
  if exist "%REPO%\Neuclip Studio.exe" explorer /select,"%REPO%\Neuclip Studio.exe"
  echo Done. Double-click "Neuclip Studio.exe" in this folder to run it ^(CPU^).
)
pause
