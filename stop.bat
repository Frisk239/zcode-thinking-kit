@echo off
title zcode-thinking-kit - stop
cd /d "%~dp0"
node cli.mjs stop
ping -n 3 127.0.0.1 >nul
