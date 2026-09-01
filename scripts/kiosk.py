#!/usr/bin/env python3
"""Compatibility entrypoint for the Chromium CDP kiosk launcher."""

from __future__ import annotations

import sys

from kiosk_chrome import main


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
