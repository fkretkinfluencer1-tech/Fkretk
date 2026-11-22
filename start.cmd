@echo off
setlocal
where.exe node.exe >nul 2>nul
if not errorlevel 1 (
  node "%~dp0server.mjs"
  exit /b %errorlevel%
)
set "NODE_ROOT=%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe"
set "NODE_EXE="
for /f "delims=" %%F in ('dir /s /b "%NODE_ROOT%\node.exe" 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%F"
if not defined NODE_EXE (
  echo Node.js LTS was not found. Install Node.js 24 or later, then try again.
  pause
  exit /b 1
)
"%NODE_EXE%" "%~dp0server.mjs"
