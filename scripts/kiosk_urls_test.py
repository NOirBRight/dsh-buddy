#!/usr/bin/env python3
"""Tests for canonical kiosk URL validation."""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
import urllib.parse
from pathlib import Path

from scripts.kiosk_urls import same_origin, validate_launch_urls


VALID_TOKEN = "A" * 43


class KioskUrlTests(unittest.TestCase):
    def test_valid_urls_share_a_canonical_origin(self) -> None:
        cases = (
            (
                "http://127.0.0.1:3082/?token=" + VALID_TOKEN,
                "http://127.0.0.1:3082/buddy",
            ),
            (
                "https://Example.COM/?token=" + VALID_TOKEN,
                "https://example.com:443/buddy",
            ),
            (
                "https://bücher.example/?token=" + VALID_TOKEN,
                "https://xn--bcher-kva.example/buddy",
            ),
            (
                "http://[2001:db8::1]:80/?token=" + VALID_TOKEN,
                "http://[2001:0db8:0:0:0:0:0:1]/buddy",
            ),
        )
        for authenticate, buddy in cases:
            with self.subTest(authenticate=authenticate, buddy=buddy):
                urls = validate_launch_urls(authenticate, buddy)
                self.assertEqual(urls.authenticate_url, authenticate)
                self.assertEqual(urls.buddy_url, buddy)

    def test_same_origin_rejects_scheme_host_and_port_changes(self) -> None:
        base = validate_launch_urls(
            "https://example.com/?token=" + VALID_TOKEN,
            "https://example.com/buddy",
        )
        for candidate in (
            "http://example.com/buddy",
            "https://other.example/buddy",
            "https://example.com:444/buddy",
        ):
            with self.subTest(candidate=candidate):
                self.assertFalse(same_origin(urllib.parse.urlsplit(base.buddy_url), urllib.parse.urlsplit(candidate)))

    def test_rejects_credentials_fragments_and_path_confusion(self) -> None:
        invalid = (
            ("https://user@example.com/?token=" + VALID_TOKEN, "https://example.com/buddy"),
            ("https://example.com:pw@example.com/?token=" + VALID_TOKEN, "https://example.com/buddy"),
            ("https://example.com/?token=" + VALID_TOKEN + "#fragment", "https://example.com/buddy"),
            ("https://example.com/?token=" + VALID_TOKEN + "#", "https://example.com/buddy"),
            ("https://example.com/?token=" + VALID_TOKEN, "https://example.com/buddy#fragment"),
            ("https://example.com/?token=" + VALID_TOKEN, "https://example.com/buddy#"),
            ("https://example.com/not-root?token=" + VALID_TOKEN, "https://example.com/buddy"),
            ("https://example.com/?token=" + VALID_TOKEN, "https://example.com/buddy/"),
            ("https://example.com/?token=" + VALID_TOKEN, "https://example.com/%62uddy"),
            ("https://example.com/?token=" + VALID_TOKEN, "https://example.com/%2e%2e/buddy"),
            ("https://example.com/?token=" + VALID_TOKEN, "https://example.com/buddy?token=other"),
            ("http://[fe80::1%25eth0]/?token=" + VALID_TOKEN, "http://[fe80::1%25eth0]/buddy"),
        )
        for authenticate, buddy in invalid:
            with self.subTest(authenticate=authenticate, buddy=buddy):
                with self.assertRaises(ValueError):
                    validate_launch_urls(authenticate, buddy)

    def test_rejects_query_smuggling_malformed_urls_and_token_lengths(self) -> None:
        invalid = (
            ("https://example.com/?token=", "https://example.com/buddy"),
            ("https://example.com/?", "https://example.com/buddy"),
            ("https://example.com/?token=" + VALID_TOKEN, "https://example.com/buddy?"),
            ("https://example.com/?token=one&token=two", "https://example.com/buddy"),
            ("https://example.com/?token=" + VALID_TOKEN + "&next=other", "https://example.com/buddy"),
            ("https://example.com/?Token=token", "https://example.com/buddy"),
            ("https://example.com/?token=" + VALID_TOKEN + "%26other", "https://example.com/buddy"),
            ("https://example.com/?token=" + VALID_TOKEN, "https://example.com\\buddy"),
            ("https://example.com/?token=" + VALID_TOKEN, "https://example.com/buddy with-space"),
            ("ftp://example.com/?token=" + VALID_TOKEN, "ftp://example.com/buddy"),
            ("https://example.com:bad/?token=" + VALID_TOKEN, "https://example.com/buddy"),
            ("https:/// ?token=" + VALID_TOKEN, "https://example.com/buddy"),
        )
        invalid += tuple(("https://example.com/?token=" + "A" * length, "https://example.com/buddy") for length in (0, 1, 42, 44))
        invalid += (("https://example.com/?token=" + "A" * 42 + "!", "https://example.com/buddy"),)
        for authenticate, buddy in invalid:
            with self.subTest(authenticate=authenticate, buddy=buddy):
                with self.assertRaises(ValueError):
                    validate_launch_urls(authenticate, buddy)

    def test_cli_uses_the_same_validator(self) -> None:
        script = Path(__file__).with_name("kiosk_urls.py")
        valid_environment = {
            **os.environ,
            "DSH_BUDDY_AUTHENTICATE_URL": "http://127.0.0.1:3082/?token=" + VALID_TOKEN,
            "DSH_BUDDY_URL": "http://127.0.0.1:3082/buddy",
        }
        valid = subprocess.run([sys.executable, str(script)], env=valid_environment, capture_output=True, text=True, check=False)
        self.assertEqual(valid.returncode, 0, valid.stderr)
        invalid_environment = {**valid_environment, "DSH_BUDDY_URL": "http://127.0.0.1:3083/buddy"}
        invalid = subprocess.run([sys.executable, str(script)], env=invalid_environment, capture_output=True, text=True, check=False)
        self.assertEqual(invalid.returncode, 2)
        self.assertNotIn("token", invalid.stderr)



    def test_legacy_kiosk_entrypoint_delegates_to_cdp(self) -> None:
        legacy = Path(__file__).with_name("kiosk.py").read_text(encoding="utf-8")
        self.assertIn("from kiosk_chrome import main", legacy)
        self.assertNotIn("WebKit", legacy)
        self.assertNotIn("gi", legacy)
        self.assertNotIn("load_uri", legacy)
        self.assertNotIn("authenticate_url", legacy)

    def test_shell_delegates_validation_and_never_passes_auth_url_to_chrome(self) -> None:
        shell = Path(__file__).with_name("kiosk.sh").read_text(encoding="utf-8")
        self.assertIn('python3 "$ROOT/scripts/kiosk_urls.py"', shell)
        self.assertIn('CHROME="${DSH_BUDDY_CHROME:-}"', shell)
        self.assertLess(shell.index('CHROME="${DSH_BUDDY_CHROME:-}"'), shell.index('command -v google-chrome'))
        self.assertIn('exec python3 "$ROOT/scripts/kiosk_chrome.py" "$@"', shell)
        self.assertNotIn('kiosk.py', shell)
        self.assertNotIn('WebKit', shell)
        self.assertNotIn('--dump-dom "$AUTH_URL"', shell)
        self.assertNotIn('exec "$CHROME"', shell)


if __name__ == "__main__":
    unittest.main()
