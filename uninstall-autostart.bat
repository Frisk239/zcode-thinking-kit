@echo off
title zcode-thinking-kit - uninstall autostart
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\zcode-thinking-kit.lnk"
if exist "%LNK%" (del "%LNK%" & echo [OK] autostart removed) else (echo autostart not installed, nothing to do)
ping -n 2 127.0.0.1 >nul
