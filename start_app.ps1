# LibreFlow Annotate – Combined App Launcher
# Starts both the Python inference server and the Node.js web server.
# When this PowerShell window is closed (or Ctrl+C is pressed), both servers are
# shut down cleanly via the finally block.

$ErrorActionPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  LibreFlow Annotate" -ForegroundColor Cyan
Write-Host "  ==================" -ForegroundColor Cyan
Write-Host ""

# ── Resolve paths ─────────────────────────────────────────────────────────────
$pyScripts  = Join-Path $projectRoot "py_scripts"
$venvPython = Join-Path $pyScripts   ".venv\Scripts\python.exe"
$venvPip    = Join-Path $pyScripts   ".venv\Scripts\pip.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "  [ERR] Python .venv not found at: $pyScripts\.venv" -ForegroundColor Red
    Write-Host "  Run: py -3.10 -m venv py_scripts\.venv && py_scripts\.venv\Scripts\pip install -r py_scripts\requirements.txt" -ForegroundColor Yellow
    Read-Host "  Press Enter to exit"
    exit 1
}

# ── Start inference server ─────────────────────────────────────────────────────
Write-Host "  [1/2] Starting Python inference server on http://127.0.0.1:7878 ..." -ForegroundColor Green

$uvicornArgs = "-m uvicorn infer_server:app --host 127.0.0.1 --port 7878 --log-level info"
$inferProc = Start-Process `
    -FilePath       $venvPython `
    -ArgumentList   $uvicornArgs `
    -WorkingDirectory $pyScripts `
    -PassThru `
    -NoNewWindow

Write-Host "  [1/2] Inference server PID: $($inferProc.Id)" -ForegroundColor DarkGreen

# Give the inference server a moment to bind
Start-Sleep -Seconds 2

# Quick health check
try {
    $health = Invoke-RestMethod "http://127.0.0.1:7878/health" -TimeoutSec 4
    Write-Host "  [1/2] Inference server ready. Status: $($health.status)" -ForegroundColor DarkGreen
} catch {
    Write-Host "  [1/2] Inference server still starting (this is normal for first-run model loading)." -ForegroundColor Yellow
}

Write-Host ""

# ── Start Node.js web server ───────────────────────────────────────────────────
Write-Host "  [2/2] Starting Node.js web server on http://localhost:6767 ..." -ForegroundColor Green

$nodeProc = Start-Process `
    -FilePath       "node" `
    -ArgumentList   "server.js" `
    -WorkingDirectory $projectRoot `
    -PassThru `
    -NoNewWindow

Write-Host "  [2/2] Node.js server PID: $($nodeProc.Id)" -ForegroundColor DarkGreen
Write-Host ""
Write-Host "  App running at http://localhost:6767" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop both servers." -ForegroundColor Gray
Write-Host ""

# ── Wait and monitor ──────────────────────────────────────────────────────────
# Register Ctrl+C handler
[Console]::TreatControlCAsInput = $false
$exitCode = 0

try {
    # Wait for Node process to exit (it's the primary server)
    $nodeProc.WaitForExit()
    $exitCode = $nodeProc.ExitCode
    if ($exitCode -ne 0) {
        Write-Host ""
        Write-Host "  [!] Node.js server exited with code $exitCode" -ForegroundColor Red
    }
} finally {
    Write-Host ""
    Write-Host "  Shutting down..." -ForegroundColor Yellow

    # Kill inference server and all child processes
    if ($inferProc -and -not $inferProc.HasExited) {
        Write-Host "  Stopping inference server (PID $($inferProc.Id))..." -ForegroundColor Gray
        # Kill the process tree (uvicorn spawns worker processes)
        taskkill /PID $inferProc.Id /T /F 2>$null | Out-Null
    }

    # Kill Node if it's still running (e.g. if user Ctrl+C'd)
    if ($nodeProc -and -not $nodeProc.HasExited) {
        Write-Host "  Stopping Node.js server (PID $($nodeProc.Id))..." -ForegroundColor Gray
        $nodeProc.Kill() 2>$null
    }

    # Belt-and-suspenders: kill any stray uvicorn/python on port 7878
    $stuck = netstat -ano 2>$null | Select-String ":7878.*LISTENING"
    if ($stuck) {
        $pid7878 = ($stuck -split '\s+')[-1]
        if ($pid7878 -match '^\d+$') { taskkill /PID $pid7878 /T /F 2>$null | Out-Null }
    }

    Write-Host "  Stopped. Goodbye." -ForegroundColor Cyan
    Write-Host ""
}
