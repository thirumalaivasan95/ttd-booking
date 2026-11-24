@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('%~dp0build.ps1')))"
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
if /i "%~1"=="install" (
  start "" "%~dp0install.html"
) else (
  start "" "https://ttdevasthanams.ap.gov.in/slot-booking?flow=sed&flowIdentifier=sed"
  echo Log in with your OTP, then click the TTD Helper bookmark.
)
