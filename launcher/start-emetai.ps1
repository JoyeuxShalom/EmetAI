# EmetAI launcher - everything the operator needs, in one double-click.
#
# Replaces "cd server, python app.py, wait, guess when it's ready, open a
# browser". Each of those was its own small frustration, and the last one was
# a real failure: pressing Listen before the speech models had loaded looks
# exactly like EmetAI being broken.
#
# What this does, in order:
#   1. Finds Python, and installs the dependencies if they are missing.
#   2. Clears a stale EmetAI still holding the port - the single most common
#      problem this project has had, and never the operator's fault.
#   3. Starts the backend and waits for /api/ready, showing real progress.
#   4. Opens the Studio once it is genuinely ready.
#   5. Stays running as a watchdog: if the backend dies mid-service it is
#      restarted automatically, because a service does not stop for a crash.
#   6. Shuts everything down cleanly when this window is closed.

$ErrorActionPreference = "Stop"
$Port = 8765

# Find the project by looking for server\app.py, walking up from wherever this
# script happens to have been started. $PSScriptRoot is empty in some ways of
# invoking a script, and "it worked when I double-clicked it" is not a standard
# a church laptop should have to meet.
function Find-ProjectRoot {
    $starts = @()
    if ($PSCommandPath) { $starts += Split-Path -Parent $PSCommandPath }
    if ($PSScriptRoot) { $starts += $PSScriptRoot }
    if ($MyInvocation.MyCommand.Path) { $starts += Split-Path -Parent $MyInvocation.MyCommand.Path }
    $starts += (Get-Location).Path

    foreach ($start in $starts) {
        $dir = $start
        for ($up = 0; $up -lt 4 -and $dir; $up++) {
            if (Test-Path (Join-Path $dir "server\app.py")) { return $dir }
            $dir = Split-Path -Parent $dir
        }
    }
    return $null
}

$Root = Find-ProjectRoot
if (-not $Root) {
    Write-Host ""
    Write-Host "   Could not find EmetAI's files." -ForegroundColor Red
    Write-Host "   Keep 'Start EmetAI.bat' inside the EmetAI folder." -ForegroundColor Red
    Read-Host "`n   Press Enter to close"
    exit 1
}
$ServerDir = Join-Path $Root "server"
$LogDir = Join-Path $ServerDir "data"
$LogFile = Join-Path $LogDir "emetai.log"
$Url = "http://127.0.0.1:$Port"

$Host.UI.RawUI.WindowTitle = "EmetAI"

function Say($text, $colour = "Gray") {
    # Strip anything the console code page cannot render. Mojibake in a status
    # line reads as a broken program, and this text can come from the server.
    $clean = ($text -replace "[^ -~]", "")
    Write-Host "  $clean" -ForegroundColor $colour
}

function Banner {
    Clear-Host
    Write-Host ""
    Write-Host "   EmetAI" -ForegroundColor Yellow
    Write-Host "   Scripture, the moment it is spoken" -ForegroundColor DarkGray
    Write-Host ""
}

# ---------------------------------------------------------------- python ----
function Find-Python {
    foreach ($candidate in @(
        @{ Exe = "py";     Args = @("-3") },
        @{ Exe = "python"; Args = @() }
    )) {
        try {
            $probe = & $candidate.Exe @($candidate.Args + @("-c", "import sys; print(sys.version_info[0])")) 2>$null
            if ($LASTEXITCODE -eq 0 -and $probe -ge 3) { return $candidate }
        } catch { }
    }
    return $null
}

function Test-Dependencies($py) {
    & $py.Exe @($py.Args + @("-c", "import fastapi, uvicorn, numpy, faster_whisper")) 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# ------------------------------------------------------------------ port ----
function Get-PortOwner {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                Select-Object -First 1
        if (-not $conn) { return $null }
        return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    } catch { return $null }
}

function Clear-StalePort {
    $owner = Get-PortOwner
    if (-not $owner) { return $true }
    # A leftover EmetAI from a previous run is ours to clean up. Anything else
    # belongs to the operator and must never be killed behind their back.
    if ($owner.ProcessName -match "python") {
        Say "Clearing a previous EmetAI that was still running..." "DarkYellow"
        Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
        return $null -eq (Get-PortOwner)
    }
    Say "Port $Port is being used by '$($owner.ProcessName)' (process $($owner.Id))." "Red"
    Say "Close that program, then start EmetAI again." "Red"
    return $false
}

# --------------------------------------------------------------- backend ----
function Start-Backend($py) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    return Start-Process -FilePath $py.Exe `
        -ArgumentList ($py.Args + @("app.py")) `
        -WorkingDirectory $ServerDir `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError (Join-Path $LogDir "emetai.err.log") `
        -WindowStyle Hidden -PassThru
}

function Get-Readiness {
    try {
        return Invoke-RestMethod -Uri "$Url/api/ready" -TimeoutSec 3 -ErrorAction Stop
    } catch { return $null }
}

function Wait-Ready($proc) {
    # Up to three minutes: a cold first run reads the Kinyarwanda model off
    # disk, which is the slow part and only slow once.
    $deadline = (Get-Date).AddMinutes(3)
    $spin = @("|", "/", "-", "\")
    $i = 0
    $lastDetail = ""
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { return "crashed" }
        $state = Get-Readiness
        if ($state) {
            if ($state.detail -ne $lastDetail -and -not $state.ready) {
                $lastDetail = $state.detail
                Write-Host ""
                Say $state.detail "Gray"
            }
            if ($state.ready) { return "ready" }
        }
        Write-Host "`r   $($spin[$i % 4]) " -NoNewline -ForegroundColor DarkGray
        $i++
        Start-Sleep -Milliseconds 400
    }
    return "timeout"
}

# ------------------------------------------------------------------ main ----
Banner

$py = Find-Python
if (-not $py) {
    Say "Python is not installed on this computer." "Red"
    Say "Install it from https://python.org/downloads (tick 'Add to PATH')," "Red"
    Say "then start EmetAI again." "Red"
    Read-Host "`n   Press Enter to close"
    exit 1
}

if (-not (Test-Dependencies $py)) {
    Say "First run - installing what EmetAI needs. This takes a few minutes." "Yellow"
    Say "It only happens once." "DarkGray"
    Write-Host ""
    & $py.Exe @($py.Args + @("-m", "pip", "install", "-r",
                             (Join-Path $ServerDir "requirements.txt"), "--quiet"))
    if (-not (Test-Dependencies $py)) {
        Write-Host ""
        Say "Could not install everything EmetAI needs." "Red"
        Say "Check your internet connection and try again." "Red"
        Read-Host "`n   Press Enter to close"
        exit 1
    }
    Banner
}

$cleared = Clear-StalePort
if ($cleared -eq $false) { Read-Host "`n   Press Enter to close"; exit 1 }

Say "Starting EmetAI..." "Gray"
$proc = Start-Backend $py
$state = Wait-Ready $proc
Write-Host "`r     `r" -NoNewline

switch ($state) {
    "ready" {
        Write-Host ""
        Say "EmetAI is ready." "Green"
        Say "Opening the Studio..." "DarkGray"
        Start-Process $Url
    }
    "crashed" {
        Say "EmetAI stopped while starting up." "Red"
        Say "The details are in: $LogFile" "DarkGray"
        Read-Host "`n   Press Enter to close"
        exit 1
    }
    default {
        Say "EmetAI is taking longer than expected." "DarkYellow"
        Say "Opening the Studio anyway - listening may be slow for a moment." "DarkGray"
        Start-Process $Url
    }
}

Write-Host ""
Write-Host "   ---------------------------------------------" -ForegroundColor DarkGray
Say "EmetAI is running at $Url" "Gray"
Say "Keep this window open during the service." "DarkGray"
Say "Closing it stops EmetAI." "DarkGray"
Write-Host "   ---------------------------------------------" -ForegroundColor DarkGray
Write-Host ""

# ------------------------------------------------------------- watchdog ----
# A crash two minutes into a sermon must not end the service. Restart, say so
# quietly, and carry on - but stop trying if it is failing repeatedly, because
# an endless restart loop hides the real problem.
$restarts = 0
try {
    while ($true) {
        Start-Sleep -Seconds 3
        if (-not $proc.HasExited) { continue }
        $restarts++
        if ($restarts -gt 5) {
            Say "EmetAI has stopped repeatedly. See $LogFile" "Red"
            Read-Host "`n   Press Enter to close"
            break
        }
        Say "EmetAI stopped unexpectedly - restarting ($restarts of 5)..." "DarkYellow"
        $proc = Start-Backend $py
        if ((Wait-Ready $proc) -eq "ready") {
            Write-Host "`r     `r" -NoNewline
            Say "Running again. Press Listen to carry on." "Green"
        }
    }
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}
