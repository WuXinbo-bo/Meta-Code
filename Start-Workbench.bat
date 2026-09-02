@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-workbench.ps1"
if errorlevel 1 (
  echo.
  echo Failed to start Meta Code. Check %USERPROFILE%\.metacode\logs.
  pause
  exit /b 1
)
endlocal
