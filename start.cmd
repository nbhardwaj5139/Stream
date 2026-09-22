@echo off
REM Double-click this, or run it from any folder. It works out where it lives,
REM so you never have to be in the right directory first.
cd /d "%~dp0"
node bin\stream.js %*
if errorlevel 1 pause
