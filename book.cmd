@echo off
cd /d "%~dp0"
if not exist node_modules\playwright-core (
  echo Installing playwright-core...
  call npm install --no-audit --no-fund
)
node book.js %*
pause
