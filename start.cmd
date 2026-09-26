@echo off
REM Double-click this, or run it from any folder. It works out where it lives,
REM updates itself, and starts the room. Nothing else to remember.
REM
REM No labels or GOTOs on purpose: this file is stored with Unix line endings,
REM and cmd.exe can fail to find a label in a file like that.
cd /d "%~dp0"
title Stream - leave this window open

REM Pull quietly, and never let a failed update stop the evening: being a day
REM behind is a far smaller problem than not starting at all.
where git >nul 2>&1 && git rev-parse --is-inside-work-tree >nul 2>&1 && (
  echo Checking for updates...
  git pull --ff-only --quiet || echo   Could not update. Carrying on with what is already here.
)
echo.

node bin\stream.js %*
if errorlevel 1 pause
