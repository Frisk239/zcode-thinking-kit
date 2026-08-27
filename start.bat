@echo off
title zcode-thinking-kit
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Node.js 18+ is required and was not found in PATH
  pause
  exit /b 1
)
node cli.mjs start
if errorlevel 1 pause
ping -n 3 127.0.0.1 >nul
