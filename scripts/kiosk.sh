#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${DSH_BUDDY_URL:-http://127.0.0.1:3082/buddy}"
export DSH_BUDDY_URL="$URL"

if python3 - <<'PY'
import gi, sys
gi.require_version('Gtk', '4.0')
gi.require_version('WebKit', '6.0')
from gi.repository import Gtk, WebKit  # noqa: F401
PY
then
  exec python3 "$ROOT/scripts/kiosk.py" "$@"
fi

CHROME="$(command -v google-chrome || command -v chromium-browser || command -v chromium || true)"
if [[ -z "$CHROME" ]]; then
  echo "Need gir1.2-webkit-6.0 + python3-gi, or Chrome/Chromium." >&2
  exit 1
fi

DATA="${XDG_RUNTIME_DIR:-/tmp}/dsh-buddy-kiosk"
mkdir -p "$DATA"
# X11 lets us place the window on HDMI-1 (960x400 at +1920+0). On pure Wayland,
# drag the app window onto the sub-screen once.
exec "$CHROME" \
  --user-data-dir="$DATA" \
  --app="$URL" \
  --window-size=960,400 \
  --window-position=1920,0 \
  --ozone-platform=x11 \
  --disable-features=Translate \
  --no-first-run
