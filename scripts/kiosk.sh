#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${DSH_BUDDY_URL:-http://127.0.0.1:3082/buddy}"
export DSH_BUDDY_URL="$URL"

if [[ -z "${DSH_BUDDY_AUTHENTICATE_URL:-}" ]]; then
  echo "Set DSH_BUDDY_AUTHENTICATE_URL to the one-time root authentication URL before launching the kiosk." >&2
  exit 2
fi

if ! python3 "$ROOT/scripts/kiosk_urls.py"; then
  exit 2
fi

CHROME="${DSH_BUDDY_CHROME:-}"
if [[ -z "$CHROME" ]]; then
  CHROME="$(command -v google-chrome || command -v chromium-browser || command -v chromium || true)"
  if [[ -z "$CHROME" ]]; then
    echo "Need Chrome/Chromium for the CDP kiosk path." >&2
    exit 1
  fi
  export DSH_BUDDY_CHROME="$CHROME"
fi

# Chromium receives only display/runtime environment; the token uses DevTools, never argv.
exec python3 "$ROOT/scripts/kiosk_chrome.py" "$@"
