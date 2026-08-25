@echo off
chcp 65001 >nul
title QCpet Dev
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js was not found. Install Node.js and run this script again.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [!] Rust/Cargo was not found.
  echo [!] Install Rust stable from https://rustup.rs/ and run this script again.
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

echo [*] Starting QCpet...
call npm.cmd run tauri dev
if errorlevel 1 echo [!] QCpet failed to start. See the error above.
pause
