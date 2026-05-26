#!/bin/bash
set -euo pipefail

LOG_FILE="/var/log/cloudflared.log"
ENV_FILE="/srv/aicombinator/supervisor/.env"
URL_FILE="/tmp/tunnel-url"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

wait_for_url() {
  local url=""
  for _ in $(seq 1 30); do
    url=$(grep -o "https://[^ ]*\\.trycloudflare\\.com" "$LOG_FILE" 2>/dev/null | tail -1 || true)
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url" > "$URL_FILE"
      printf 'Tunnel URL: %s\n' "$url"
      SHARED_TUNNEL_URL="$url"
      return 0
    fi
    sleep 1
  done

  printf 'ERROR: Could not determine cloudflared tunnel URL\n' >&2
  return 1
}

register_with_worker() {
  if [[ -z "${WORKER_API_URL:-}" || -z "${INTERNAL_API_KEY:-}" || -z "${SHARED_TUNNEL_URL:-}" ]]; then
    printf 'Skipping worker registration; missing WORKER_API_URL, INTERNAL_API_KEY, or SHARED_TUNNEL_URL\n'
    return 0
  fi

  curl -fsS -X POST "${WORKER_API_URL%/}/api/supervisor/shared-origin/register" \
    -H "Content-Type: application/json" \
    -H "X-Supervisor-Key: ${INTERNAL_API_KEY}" \
    --data "{\"url\":\"${SHARED_TUNNEL_URL}\"}" >/dev/null

  printf 'Registered shared supervisor origin with worker: %s\n' "$SHARED_TUNNEL_URL"
}

wait_for_url
register_with_worker
