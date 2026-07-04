@echo off
REM Neuclip Studio - build the standalone app (Windows).
REM Produces the "Neuclip Studio" folder (fast-launching app - double-click the .exe
REM inside) in this folder, and on an NVIDIA machine automatically also builds
REM "Neuclip Studio GPU" that uses your GPU on double-click.
REM Copy either folder to any PC - NO Python needed on that machine.
REM This takes a few minutes. For everyday use, "Open Neuclip Studio.bat" is faster.
setlocal
title Build Neuclip Studio
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

echo Installing build tools (first run only)...
"%VPY%" -m pip install --quiet --upgrade pip
"%VPY%" -m pip install --quiet -r "%REPO%\sidecar\requirements.txt" pyinstaller pywebview pillow || (echo Install failed. Scroll up for the error. & pause & exit /b 1)

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
  echo "Neuclip Studio GPU.exe" inside it. ^(The "Neuclip Studio" folder is the CPU build.^)
  explorer /select,"%REPO%\Neuclip Studio GPU"
) else (
  if exist "%REPO%\Neuclip Studio" explorer /select,"%REPO%\Neuclip Studio"
  echo Done. Open the "Neuclip Studio" folder and double-click "Neuclip Studio.exe" ^(CPU^).
)
pause
exit /b 0

:nopython
echo Python 3 is required ^(the Microsoft Store "python" shortcut doesn't count^).
echo Install it from https://www.python.org/downloads/ - during install, tick
echo "Add Python to PATH" - then double-click this file again.
pause & exit /b 1
