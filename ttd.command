#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

if command -v pwsh >/dev/null 2>&1; then
  pwsh -NoProfile -File build.ps1 || { echo "Build failed."; exit 1; }
else
  echo "PowerShell (pwsh) not found; using the existing install.html and bookmarklet.txt."
fi

if command -v open >/dev/null 2>&1; then OPENER=open; else OPENER=xdg-open; fi

if [ "$1" = "install" ]; then
  "$OPENER" install.html
else
  "$OPENER" "https://ttdevasthanams.ap.gov.in/slot-booking?flow=sed&flowIdentifier=sed"
  echo "Log in with your OTP, then click the TTD Helper bookmark."
fi
