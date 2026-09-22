@echo off
cd /d "%~dp0"
echo Kiem tra/cap nhat thu vien Posttool...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo Khong cai duoc thu vien. Hay kiem tra Node.js va ket noi Internet.
  pause
  exit /b 1
)
start "" http://localhost:3000
npm start
pause
