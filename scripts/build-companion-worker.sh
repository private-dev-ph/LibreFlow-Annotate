#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
worker_python="${LIBREFLOW_BUILD_PYTHON:-python3}"
worker_wheelhouse="$(mktemp -d "${TMPDIR:-/tmp}/libreflow-worker-wheels.XXXXXXXX")"
trap 'rm -rf -- "$worker_wheelhouse"' EXIT
"$worker_python" -m pip download --only-binary=:all: --dest "$worker_wheelhouse" \
  'pip==26.2.1' 'onnxruntime==1.30.0' 'numpy==2.5.2' 'opencv-python-headless==5.0.0.93' 'flatbuffers==25.12.19' 'protobuf==7.36.2'
"$worker_python" scripts/verify-worker-wheels.py "$worker_wheelhouse"
docker build --target worker-offline --build-context "wheelhouse=$worker_wheelhouse" \
  -f Dockerfile.companion-worker -t libreflow-companion-worker:local .
