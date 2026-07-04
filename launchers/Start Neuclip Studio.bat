@echo off
setlocal enabledelayedexpansion
title Neuclip Studio
color 0E
cd /d "%~dp0.."
set "REPO=%CD%"
set "INSTALLED="

echo ========================================
echo    Neuclip Studio launcher (Windows)
echo ========================================
echo.
echo First run installs everything (Python, Node, Rust, build tools, deps).
echo This can take a while. Later runs just open the app.
echo.

REM --- winget (App Installer) ------------------------------------------------
where winget >nul 2>&1
if errorlevel 1 (
  echo [X] "winget" was not found.
  echo     Install "App Installer" from the Microsoft Store, then run this again.
  pause & exit /b 1
)

REM --- Python 3.11 ----------------------------------------------------------
where python >nul 2>&1
if errorlevel 1 (
  echo Installing Python 3.11...
  winget install -e --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
  set "INSTALLED=1"
)

REM --- Node.js LTS ----------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo Installing Node.js LTS...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  set "INSTALLED=1"
)

REM --- Rust -----------------------------------------------------------------
where cargo >nul 2>&1
if errorlevel 1 (
  echo Installing Rust...
  winget install -e --id Rustlang.Rustup --silent --accept-package-agreements --accept-source-agreements
  set "INSTALLED=1"
)

REM --- MSVC C++ build tools (Rust needs these on Windows) -------------------
if not exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools" (
  if not exist "%ProgramFiles%\Microsoft Visual Studio\2022" (
    echo Installing Visual Studio C++ Build Tools...
    winget install -e --id Microsoft.VisualStudio.2022.BuildTools --silent --accept-package-agreements --accept-source-agreements --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    set "INSTALLED=1"
  )
)

REM --- if we just installed tools, PATH needs a fresh window ----------------
if defined INSTALLED (
  echo.
  echo ============================================================
  echo   Setup installed new components.
  echo   Please CLOSE this window and double-click the launcher
  echo   again to finish setup and open Neuclip Studio.
  echo ============================================================
  pause & exit /b 0
)

REM --- Tauri CLI ------------------------------------------------------------
cargo tauri --version >nul 2>&1
if errorlevel 1 (
  echo Installing Tauri CLI ^(one-time, compiles^)...
  cargo install tauri-cli --version "^2" --locked || goto :fail
)

REM --- sidecar (Python venv + deps) -----------------------------------------
if not exist "%REPO%\sidecar\.venv" (
  echo Creating Python environment...
  python -m venv "%REPO%\sidecar\.venv" || goto :fail
)
set "VENV_PY=%REPO%\sidecar\.venv\Scripts\python.exe"
REM repair a venv that exists without pip (Pythons missing ensurepip create these)
"%VENV_PY%" -m pip --version >nul 2>&1
if errorlevel 1 "%VENV_PY%" -m ensurepip --upgrade --default-pip >nul 2>&1
"%VENV_PY%" -m pip --version >nul 2>&1
if errorlevel 1 (
  echo Recreating Python environment ^(pip missing^)...
  rmdir /s /q "%REPO%\sidecar\.venv"
  python -m venv "%REPO%\sidecar\.venv" || goto :fail
  "%VENV_PY%" -m ensurepip --upgrade --default-pip >nul 2>&1
)
echo Installing sidecar dependencies...
"%VENV_PY%" -m pip install --quiet --upgrade pip
"%VENV_PY%" -m pip install --quiet -r "%REPO%\sidecar\requirements.txt" pyinstaller || goto :fail

REM --- frontend -------------------------------------------------------------
if not exist "%REPO%\frontend\node_modules" (
  echo Installing frontend dependencies...
  pushd "%REPO%\frontend" && call npm install --no-audit --no-fund && popd || goto :fail
)

REM --- freeze sidecar so Tauri externalBin resolves -------------------------
for /f "tokens=2" %%a in ('rustc -vV ^| findstr /b "host:"') do set "TRIPLE=%%a"
if not exist "%REPO%\src-tauri\binaries\neuclip-sidecar-%TRIPLE%.exe" (
  echo Packaging the sidecar ^(one-time^)...
  pushd "%REPO%\sidecar" && "%VENV_PY%" build_sidecar.py && popd || goto :fail
)

REM --- launch ---------------------------------------------------------------
echo.
echo Opening Neuclip Studio... ^(first launch compiles the app - be patient^)
cd /d "%REPO%\src-tauri"
cargo tauri dev || goto :fail
exit /b 0

:fail
echo.
echo [X] Something failed above. Scroll up to see the error.
pause & exit /b 1
