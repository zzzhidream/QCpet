@echo off
chcp 65001 >nul
title QCpet Portable Build
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未找到 Node.js。
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [!] 未找到 Rust/Cargo。
  pause
  exit /b 1
)

if not exist "node_modules\" call npm.cmd ci
if errorlevel 1 goto :failed

call npm.cmd run package:portable
if errorlevel 1 goto :failed

echo [OK] 正式便携版已生成到 release 文件夹。
pause
exit /b 0

:failed
echo [!] 构建失败，请查看上方错误。
pause
exit /b 1
