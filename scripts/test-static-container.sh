#!/usr/bin/env bash
set -euo pipefail
static_image="${LIBREFLOW_STATIC_IMAGE:-libreflow-web:development}"
static_container="$(docker run --detach --read-only --cap-drop=ALL --security-opt=no-new-privileges \
 --tmpfs /tmp --tmpfs /var/cache/nginx:uid=101,gid=101 -p 127.0.0.1::8080 "$static_image")"
trap 'docker rm --force "$static_container" >/dev/null' EXIT
static_port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' "$static_container")"
export LIBREFLOW_WEB_TEST_URL="http://127.0.0.1:$static_port"
python3 scripts/test_static_host.py
python3 scripts/test_web_browser.py
