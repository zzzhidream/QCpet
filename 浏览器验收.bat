@echo off
chcp 65001 >nul
setlocal
title QCpet Browser Review
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js was not found. Install Node.js LTS and run this script again.
  pause
  exit /b 1
)

for /f "delims=" %%A in ('node -p "process.arch"') do set "NODE_ARCH=%%A"
set "ROLLUP_PACKAGE=node_modules\@rollup\rollup-win32-%NODE_ARCH%-msvc\package.json"
set "ESBUILD_PACKAGE=node_modules\@esbuild\win32-%NODE_ARCH%\package.json"
set "NEED_DEPENDENCIES="

if not exist "node_modules\" set "NEED_DEPENDENCIES=1"
if not exist "%ROLLUP_PACKAGE%" set "NEED_DEPENDENCIES=1"
if not exist "%ESBUILD_PACKAGE%" set "NEED_DEPENDENCIES=1"

if defined NEED_DEPENDENCIES (
  echo [*] Installing or repairing Windows frontend dependencies...
  echo [*] Checking Rollup and Esbuild components for Windows %NODE_ARCH%...
  call npm.cmd install --include=optional --no-audit --no-fund
  if errorlevel 1 (
    echo [!] Standard dependency repair reported an error. Trying direct platform repair...
  )
)

if exist "%ROLLUP_PACKAGE%" if exist "%ESBUILD_PACKAGE%" goto dependencies_ready

for /f "delims=" %%A in ('node -p "require('./node_modules/rollup/package.json').version"') do set "ROLLUP_VERSION=%%A"
for /f "delims=" %%A in ('node -p "require('./node_modules/esbuild/package.json').version"') do set "ESBUILD_VERSION=%%A"
echo [*] Installing Windows platform components directly...
call npm.cmd install --no-save --package-lock=false --no-audit --no-fund "@rollup/rollup-win32-%NODE_ARCH%-msvc@%ROLLUP_VERSION%" "@esbuild/win32-%NODE_ARCH%@%ESBUILD_VERSION%"
if errorlevel 1 (
  echo [!] Windows platform component installation failed.
  pause
  exit /b 1
)

:dependencies_ready

if not exist "%ROLLUP_PACKAGE%" (
  echo [!] Rollup Windows component is still missing: %ROLLUP_PACKAGE%
  echo [!] Rename or remove node_modules, then run this script again.
  pause
  exit /b 1
)

if not exist "%ESBUILD_PACKAGE%" (
  echo [!] Esbuild Windows component is still missing: %ESBUILD_PACKAGE%
  echo [!] Rename or remove node_modules, then run this script again.
  pause
  exit /b 1
)

echo [*] Opening QCpet PSD browser review...
echo [*] This mode does not use Rust, Cargo, Tauri, or Petra.
echo [*] Starting from port 1421. If it is occupied, Vite will use the next free port.
call npm.cmd run dev:browser
if errorlevel 1 echo [!] Browser review failed to start. See the error above.
pause
