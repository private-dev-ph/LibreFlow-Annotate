#!/usr/bin/env bash
set -euo pipefail
# Pinned upstream OSS CLI, avoiding hosted-action licensing requirements.
scan_version=8.24.3
scan_sha256=9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c
scan_dir="$(mktemp -d "${TMPDIR:-/tmp}/libreflow-gitleaks.XXXXXXXX")"
trap 'rm -rf -- "$scan_dir"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
 "https://github.com/gitleaks/gitleaks/releases/download/v${scan_version}/gitleaks_${scan_version}_linux_x64.tar.gz" \
 --output "$scan_dir/gitleaks.tar.gz"
printf '%s  %s\n' "$scan_sha256" "$scan_dir/gitleaks.tar.gz" | sha256sum --check --status
tar -xzf "$scan_dir/gitleaks.tar.gz" -C "$scan_dir" gitleaks
"$scan_dir/gitleaks" git --redact --no-banner .
