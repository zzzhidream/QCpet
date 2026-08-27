@echo off
chcp 65001 >nul
title QCpet Browser Review
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js was not found. Install Node.js LTS and run this script again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [*] Installing frontend dependencies for the first run...
  call npm.cmd install
  if errorlevel 1 (
    echo [!] Dependency installation failed.
    pause
    exit /b 1
  )
)

echo [*] Opening QCpet PSD browser review...
echo [*] This mode does not use Rust, Cargo, Tauri, or Petra.
echo [*] Review URL: http://127.0.0.1:1421/browser.html
call npm.cmd run dev:browser
if errorlevel 1 echo [!] Browser review failed to start. See the error above.
pause
