@echo off
title zcode-thinking-kit - install autostart
set "KIT=%~dp0"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\zcode-thinking-kit.lnk"
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%LNK%'); $s.TargetPath = 'cmd.exe'; $s.Arguments = '/c ""%KIT%start.bat""'; $s.WorkingDirectory = '%KIT%'; $s.WindowStyle = 7; $s.Description = 'zcode-thinking-kit local proxy'; $s.Save()"
if exist "%LNK%" (
    echo [OK] autostart enabled: start.bat runs minimized at Windows logon
) else (
    echo [FAIL] shortcut creation failed
)
ping -n 3 127.0.0.1 >nul
