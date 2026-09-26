@echo off
REM Double-click to set this laptop up to host the room. Safe to run again.
REM It fetches install.ps1 from the project and runs it: installs what is
REM missing, downloads the project, connects Cloudflare, adds the Start Stream
REM button and makes it start with Windows.
title Stream - install

powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $ErrorActionPreference = 'Stop'; try { $web = New-Object Net.WebClient; $web.Encoding = [Text.Encoding]::UTF8; Invoke-Expression $web.DownloadString('https://raw.githubusercontent.com/nbhardwaj5139/Stream/HEAD/install.ps1') } catch { Write-Host ''; Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }"

echo.
pause
