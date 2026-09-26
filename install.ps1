# Sets a Windows laptop up to host the room, in one go. Safe to run again:
# every step checks whether it is already done.
#
# Normally started by double-clicking Install-Stream.cmd, which fetches this
# file. Written for Windows PowerShell 5.1, which every Windows 10 and 11
# machine has, so nothing newer than 5.1 is used here. ASCII only, because 5.1
# reads a downloaded script in the local code page.

$ErrorActionPreference = 'Stop'

$Repo = 'https://github.com/nbhardwaj5139/Stream.git'
$Dir = Join-Path $HOME 'Stream'

function Step([int]$n, [string]$text) {
  Write-Host ''
  Write-Host "[$n/6] $text" -ForegroundColor Cyan
}

function Say([string]$text) {
  Write-Host "      $text"
}

# Windows only reads PATH when a program starts, so anything installed a
# moment ago is invisible to this window until it is re-read.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

# Adds a folder to the user's PATH for good, so the room finds the program
# when it starts at login, not just in this window.
function Add-ToUserPath([string]$folder) {
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $user) { $user = '' }
  # @() because one entry would otherwise be a bare string, and adding a
  # folder to a string glues the two together.
  $parts = @($user.Split(';') | Where-Object { $_ })
  if ($parts -notcontains $folder) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $folder) -join ';'), 'User')
  }
  Update-SessionPath
}

function Test-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Install-IfMissing([string]$command, [string]$wingetId, [string]$label, [string[]]$knownFolders) {
  if (Test-Command $command) {
    Say "$label is already installed."
    return
  }
  if (-not (Test-Command 'winget')) {
    throw "winget is missing, so $label cannot be installed for you. Install 'App Installer' from the Microsoft Store, then run this again."
  }

  Say "Installing $label..."
  & winget install --id $wingetId --exact --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Update-SessionPath

  # Some installers do not add themselves to PATH. Look where they put
  # themselves, and add that folder if so.
  if (-not (Test-Command $command)) {
    foreach ($folder in $knownFolders) {
      if ($folder -and (Test-Path (Join-Path $folder "$command.exe"))) {
        Add-ToUserPath $folder
        break
      }
    }
  }
  if (-not (Test-Command $command)) {
    throw "$label was installed, but Windows cannot find it yet. Restart the laptop and run this again."
  }
  Say "$label installed."
}

# cloudflared's own rule for tunnel names, applied to this computer's name.
# Each laptop gets its own tunnel, so two laptops never fight over one.
function Get-TunnelName {
  $name = ('stream-' + $env:COMPUTERNAME).ToLower() -replace '[^a-z0-9_-]', '-'
  if ($name.Length -gt 32) { $name = $name.Substring(0, 32) }
  return $name.TrimEnd('-')
}

function Test-Hostname([string]$name) {
  return $name -match '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
}

# The address the room lives at. Asked in a normal Windows box, remembering
# the answer from a previous run.
function Read-Hostname {
  $default = ''
  $config = Join-Path $HOME '.cloudflared\config.yml'
  if (Test-Path $config) {
    $match = Select-String -Path $config -Pattern '^\s*-\s*hostname:\s*["'']?([^"''\s#]+)' | Select-Object -First 1
    if ($match) { $default = $match.Matches[0].Groups[1].Value }
  }

  Add-Type -AssemblyName Microsoft.VisualBasic
  while ($true) {
    $answer = [Microsoft.VisualBasic.Interaction]::InputBox(
      "Which web address should the room use?`n`nFor example: stream.yourdomain.com`n`nIt must be on the domain you just picked in Cloudflare.",
      'Stream - address',
      $default)
    if (-not $answer) { throw 'No address given, so there is nothing to set up. Run this again when you have one.' }
    $answer = $answer.Trim().ToLower() -replace '^https?://', '' -replace '/+$', ''
    if (Test-Hostname $answer) { return $answer }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(
      "'$answer' is not a web address. It should look like stream.yourdomain.com",
      'Stream - address', 'OK', 'Warning')
    $default = $answer
  }
}

function New-Shortcut([string]$path, [bool]$minimised) {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = Join-Path $Dir 'start.cmd'
  $link.WorkingDirectory = $Dir
  $link.Description = 'Start the screen-sharing room'
  # 7 is "minimised": at login it should sit on the taskbar, not in the way.
  if ($minimised) { $link.WindowStyle = 7 } else { $link.WindowStyle = 1 }
  $link.Save()
}

# ---------------------------------------------------------------- steps ---

Write-Host 'Setting this laptop up to host the room.' -ForegroundColor Green
Write-Host 'The first time takes a few minutes. Running it again is always safe.'

Step 1 'Installing what it needs'
Install-IfMissing 'git' 'Git.Git' 'Git' @("$env:ProgramFiles\Git\cmd")
Install-IfMissing 'node' 'OpenJS.NodeJS.LTS' 'Node.js' @("$env:ProgramFiles\nodejs")
Install-IfMissing 'cloudflared' 'Cloudflare.cloudflared' 'cloudflared' @(
  "${env:ProgramFiles(x86)}\cloudflared",
  "$env:ProgramFiles\cloudflared")

Step 2 'Getting the latest version'
if (Test-Path (Join-Path $Dir '.git')) {
  & git -C $Dir pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Say 'Could not update; carrying on with the copy already here.' }
  else { Say "Up to date, in $Dir" }
} elseif (Test-Path $Dir) {
  throw "$Dir already exists but is not a copy of the project. Rename or move it, then run this again."
} else {
  & git clone --quiet $Repo $Dir
  if ($LASTEXITCODE -ne 0) { throw 'Could not download the project. Check the internet connection and run this again.' }
  Say "Downloaded to $Dir"
}

Step 3 'Connecting your Cloudflare account'
if (Test-Path (Join-Path $HOME '.cloudflared\cert.pem')) {
  Say 'Already connected.'
} else {
  Say 'A browser window will open. Log in to Cloudflare, then click your domain.'
  Say 'Come back here when the page says it worked.'
  & cloudflared tunnel login | Out-Host
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $HOME '.cloudflared\cert.pem'))) {
    throw 'The Cloudflare login did not finish. Run this again and complete it in the browser.'
  }
}

Step 4 'Setting up the web address'
$hostname = Read-Hostname
$tunnel = Get-TunnelName
Say "$hostname, through the tunnel '$tunnel'"
Push-Location $Dir
try {
  & node bin\setup-tunnel.js $hostname --name $tunnel | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Setting up $hostname did not finish. The lines above say why." }
} finally {
  Pop-Location
}

Step 5 'Adding the Start Stream button'
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Start Stream.lnk') $false
Say 'On the desktop: Start Stream'
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Start Stream.lnk') $true
Say 'And it will start by itself, minimised, whenever you log in.'

# A sleeping laptop takes the site down with it. Changing that is the
# laptop owner's call, so ask rather than do it.
Add-Type -AssemblyName System.Windows.Forms
$awake = [System.Windows.Forms.MessageBox]::Show(
  "Keep this laptop awake while it is plugged in?`n`nIf it sleeps, the site goes down until it wakes. Yes means it never sleeps on the charger; on battery nothing changes.`n`nYou can change this later in Settings > System > Power.",
  'Stream - stay awake', 'YesNo', 'Question')
if ($awake -eq 'Yes') {
  & powercfg /change standby-timeout-ac 0
  Say 'It will stay awake while plugged in.'
} else {
  Say 'Sleep settings left as they were.'
}

Step 6 'Starting the room'
Start-Process -FilePath (Join-Path $Dir 'start.cmd') -WorkingDirectory $Dir
Say 'It is starting in its own window. Leave that window open.'
Say "When it says READY, open https://$hostname, sign in, and press Share screen."

Write-Host ''
Write-Host 'All done.' -ForegroundColor Green
