$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $projectRoot

try {
    # Docker Desktop BuildKit can fail before using a cached base image when DNS
    # cannot resolve auth.docker.io. The classic builder is slower but reliably
    # uses the local cache and completed this project's inference image build.
    $env:DOCKER_BUILDKIT = '0'

    Write-Host "Building LibreFlow web app image..." -ForegroundColor Cyan
    docker build -f Dockerfile -t libreflow-annotate-app:local .

    Write-Host "Building LibreFlow inference image..." -ForegroundColor Cyan
    docker build -f Dockerfile.infer -t libreflow-annotate-inference:local .

    Write-Host ""
    Write-Host "Docker images built successfully." -ForegroundColor Green
    Write-Host "Start the stack with: docker compose up -d" -ForegroundColor Gray
} finally {
    Pop-Location
}
