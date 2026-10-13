@echo off
cd /d "%~dp0"
if exist "dist\CanvasStudio-win32-x64\CanvasStudio.exe" (
  start "" "%~dp0dist\CanvasStudio-win32-x64\CanvasStudio.exe"
  exit /b 0
)
if exist "node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
  exit /b 0
)
echo Please run npm install in this folder first.
pause
