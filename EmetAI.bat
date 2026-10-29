@echo off
rem ============================================================
rem  EmetAI launcher — double-click to start everything.
rem  Starts the backend (API + AI ear + clipper) and opens the
rem  app in its own window. Close this console to stop EmetAI.
rem ============================================================
title EmetAI
cd /d "%~dp0"

echo Starting EmetAI...
start "EmetAI backend" /min cmd /c "cd server && python app.py"

rem Give the backend a moment to come up.
timeout /t 4 /nobreak >nul

set "URL=http://localhost:8765"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"

if exist "%CHROME%" (
  start "" "%CHROME%" --app=%URL%
) else if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL%
) else (
  start "" %URL%
)

echo.
echo EmetAI is running at %URL%
echo Keep the minimized "EmetAI backend" window open during the service.
