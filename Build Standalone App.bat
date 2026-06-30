@echo off
REM Neuclip Studio - build the standalone app (Windows).
REM Double-click to produce "Neuclip Studio.exe" in this folder: a single file you can copy
REM to any PC and double-click, with NO Python needed on that machine.
REM This takes a minute. For everyday use, "Open Neuclip Studio.bat" is faster.
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

echo Building the standalone app...
"%VPY%" "%REPO%\sidecar\build_app.py" || (echo Build failed. & pause & exit /b 1)

if exist "%REPO%\Neuclip Studio.exe" explorer /select,"%REPO%\Neuclip Studio.exe"
echo.
echo Done. Double-click "Neuclip Studio.exe" in this folder to run it.
pause
