@echo off
REM Double-click to set this laptop up to host the room. Safe to run again.
REM
REM This half gets Node.js and Git with Windows' own installer (winget) and
REM downloads the project; bin\install.js, inside the project, does the rest.
REM No PowerShell: fetching a script and running it is exactly what security
REM software is built to stop, and some machines will not start PowerShell at
REM all.
REM
REM No labels or GOTOs, because this file is downloaded with Unix line endings
REM and cmd.exe can fail to find a label in a file like that.
title Stream - install
setlocal

echo Setting this laptop up to host the room.
echo The first time takes a few minutes.
echo.

where winget >nul 2>&1 || (echo winget is missing, so nothing can be installed for you. & echo Install "App Installer" from the Microsoft Store, then run this again. & echo. & pause & exit /b 1)

where git >nul 2>&1 || (echo Installing Git... & winget install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements)
where node >nul 2>&1 || (echo Installing Node.js... & winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements)

REM Installers change PATH for windows opened after them, not this one.
set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\nodejs"

where git >nul 2>&1 || (echo Git did not install. Restart the laptop and run this again. & echo. & pause & exit /b 1)
where node >nul 2>&1 || (echo Node.js did not install. Restart the laptop and run this again. & echo. & pause & exit /b 1)

set "STREAM_DIR=%USERPROFILE%\Stream"
if exist "%STREAM_DIR%\.git" (echo Updating the project in %STREAM_DIR% & git -C "%STREAM_DIR%" pull --ff-only --quiet) else (echo Downloading the project to %STREAM_DIR% & git clone --quiet https://github.com/nbhardwaj5139/Stream.git "%STREAM_DIR%")
if not exist "%STREAM_DIR%\bin\install.js" (echo. & echo Could not download the project. If %STREAM_DIR% already exists and is not this project, rename it and run this again. & echo. & pause & exit /b 1)

node "%STREAM_DIR%\bin\install.js"
echo.
pause
