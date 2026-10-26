#!/bin/sh
# nginx:alpine runs /docker-entrypoint.d/*.sh before it starts: writes the browser's runtime settings from the
# container environment, so one web image serves any server. Without BILLME_PUBLIC_API_URL the address built into
# the bundle (VITE_SERVER_API_URL) stays.
set -eu
target=/usr/share/nginx/html/runtime-config.js
url="${BILLME_PUBLIC_API_URL:-}"
if [ -z "$url" ]; then
  exit 0
fi
case "$url" in
  http://*|https://*) ;;
  *) echo "runtime-config: BILLME_PUBLIC_API_URL must start with http:// or https://, ignored" >&2; exit 0 ;;
esac
if printf '%s' "$url" | grep -q '[[:space:]"\\<>]'; then
  echo "runtime-config: BILLME_PUBLIC_API_URL contains characters not allowed in a URL, ignored" >&2
  exit 0
fi
printf 'window.__BILLME_RUNTIME__ = { apiUrl: "%s" };\n' "$url" > "$target"
echo "runtime-config: API ${url}"
