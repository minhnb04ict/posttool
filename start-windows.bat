@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai thu vien...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
start "" http://localhost:3000
npm start
pause
