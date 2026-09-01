#!/usr/bin/env python3
"""Validate the two URLs used by the Buddy kiosk launchers."""

from __future__ import annotations

import dataclasses
import ipaddress
import os
import re
import sys
import urllib.parse

DEFAULT_BUDDY_URL = "http://127.0.0.1:3082/buddy"
_AUTHENTICATE_ENV = "DSH_BUDDY_AUTHENTICATE_URL"
_BUDDY_ENV = "DSH_BUDDY_URL"
_TOKEN_QUERY = re.compile(r"token=[A-Za-z0-9_-]{43}\Z")


@dataclasses.dataclass(frozen=True)
class LaunchUrls:
    """Validated root token-exchange and clean Buddy URLs."""

    authenticate_url: str
    buddy_url: str


def _parse_http_url(raw: str, label: str) -> urllib.parse.SplitResult:
    if not raw:
        raise ValueError(f"{label} is required")
    if any(ord(character) <= 0x20 or ord(character) == 0x7F for character in raw):
        raise ValueError(f"{label} contains whitespace or control characters")
    if "\\" in raw:
        raise ValueError(f"{label} must not contain backslashes")
    if "#" in raw:
        raise ValueError(f"{label} must not contain a fragment")
    if label == _BUDDY_ENV and "?" in raw:
        raise ValueError(f"{label} must not contain a query")
    try:
        parsed = urllib.parse.urlsplit(raw)
        scheme = parsed.scheme.lower()
        hostname = parsed.hostname
        parsed.port  # Force malformed-port validation.
    except ValueError as error:
        raise ValueError(f"{label} must be a valid HTTP URL") from error
    if scheme not in {"http", "https"}:
        raise ValueError(f"{label} must use http or https")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{label} must not contain username or password")
    if hostname is None or hostname == "":
        raise ValueError(f"{label} must contain a host")
    if "%" in hostname:
        raise ValueError(f"{label} must not contain an IPv6 zone identifier")
    return parsed


def _origin(parsed: urllib.parse.SplitResult) -> tuple[str, str, int]:
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname
    if hostname is None:
        raise ValueError("URL has no host")
    if ":" in hostname:
        try:
            canonical_host = ipaddress.IPv6Address(hostname).compressed.lower()
        except ValueError as error:
            raise ValueError("URL has an invalid IPv6 host") from error
    else:
        try:
            canonical_host = hostname.encode("idna").decode("ascii").lower()
        except UnicodeError as error:
            raise ValueError("URL has an invalid host") from error
    port = parsed.port
    if port is None:
        port = 80 if scheme == "http" else 443
    return scheme, canonical_host, port


def same_origin(left: urllib.parse.SplitResult, right: urllib.parse.SplitResult) -> bool:
    """Return whether two parsed URLs have the same canonical HTTP origin."""

    try:
        _parse_http_url(left.geturl(), "URL")
        _parse_http_url(right.geturl(), "URL")
        return _origin(left) == _origin(right)
    except ValueError:
        return False


def validate_launch_urls(authenticate_url: str | None = None, buddy_url: str | None = None) -> LaunchUrls:
    """Validate the root token exchange and clean /buddy URL pair."""

    auth_raw = os.environ.get(_AUTHENTICATE_ENV, "") if authenticate_url is None else authenticate_url
    buddy_raw = os.environ.get(_BUDDY_ENV, DEFAULT_BUDDY_URL) if buddy_url is None else buddy_url
    auth = _parse_http_url(auth_raw, _AUTHENTICATE_ENV)
    buddy = _parse_http_url(buddy_raw, _BUDDY_ENV)
    if not same_origin(auth, buddy):
        raise ValueError("authenticate and Buddy URLs must use the same origin")
    if auth.path != "/":
        raise ValueError(f"{_AUTHENTICATE_ENV} must use the root path /")
    if _TOKEN_QUERY.fullmatch(auth.query) is None:
        raise ValueError(f"{_AUTHENTICATE_ENV} must contain exactly one 43-character base64url token query")
    if buddy.path != "/buddy":
        raise ValueError(f"{_BUDDY_ENV} must use the exact path /buddy")
    return LaunchUrls(authenticate_url=auth_raw, buddy_url=buddy_raw)


def main() -> int:
    try:
        validate_launch_urls()
    except ValueError as error:
        print(f"kiosk URL configuration error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
