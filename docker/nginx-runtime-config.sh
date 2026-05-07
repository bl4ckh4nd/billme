#!/bin/sh
set -eu

html_root=/usr/share/nginx/html
template="$html_root/runtime-config.js.template"
target="$html_root/runtime-config.js"
runtime_api_url="${BILLME_PUBLIC_API_URL:-}"

if [ ! -f "$template" ]; then
  exit 0
fi

escaped_runtime_api_url=$(printf '%s' "$runtime_api_url" | sed 's/[&|\\]/\\&/g')
sed "s|__BILLME_PUBLIC_API_URL__|$escaped_runtime_api_url|g" "$template" > "$target"
