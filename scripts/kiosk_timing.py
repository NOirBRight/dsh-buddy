#!/usr/bin/env python3
"""Validated deployment timing for the Buddy kiosk reachability probe."""

from __future__ import annotations

import dataclasses
import math
import os
from collections.abc import Mapping


DEFAULT_WAIT_TIMEOUT_S = 30.0
DEFAULT_WAIT_REQUEST_TIMEOUT_S = 2.0
DEFAULT_WAIT_POLL_S = 0.4
MAX_WAIT_TIMEOUT_S = 300.0
MAX_WAIT_REQUEST_TIMEOUT_S = 30.0
MAX_WAIT_POLL_S = 30.0


@dataclasses.dataclass(frozen=True)
class WaitTiming:
    """Total, per-request, and polling durations in seconds."""

    total_s: float
    request_s: float
    poll_s: float


def _positive_bounded(name: str, raw: str | None, default: float, maximum: float) -> float:
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a finite number") from error
    if not math.isfinite(value) or value <= 0 or value > maximum:
        raise ValueError(f"{name} must be greater than 0 and at most {maximum:g} seconds")
    return value


def load_wait_timing(environment: Mapping[str, str] | None = None) -> WaitTiming:
    """Read bounded kiosk wait timings from environment variables."""

    values = os.environ if environment is None else environment
    total_s = _positive_bounded(
        "DSH_BUDDY_WAIT_TIMEOUT_S",
        values.get("DSH_BUDDY_WAIT_TIMEOUT_S"),
        DEFAULT_WAIT_TIMEOUT_S,
        MAX_WAIT_TIMEOUT_S,
    )
    request_s = _positive_bounded(
        "DSH_BUDDY_WAIT_REQUEST_TIMEOUT_S",
        values.get("DSH_BUDDY_WAIT_REQUEST_TIMEOUT_S"),
        DEFAULT_WAIT_REQUEST_TIMEOUT_S,
        MAX_WAIT_REQUEST_TIMEOUT_S,
    )
    poll_s = _positive_bounded(
        "DSH_BUDDY_WAIT_POLL_S",
        values.get("DSH_BUDDY_WAIT_POLL_S"),
        DEFAULT_WAIT_POLL_S,
        MAX_WAIT_POLL_S,
    )
    if request_s > total_s:
        raise ValueError("DSH_BUDDY_WAIT_REQUEST_TIMEOUT_S must not exceed DSH_BUDDY_WAIT_TIMEOUT_S")
    if poll_s > total_s:
        raise ValueError("DSH_BUDDY_WAIT_POLL_S must not exceed DSH_BUDDY_WAIT_TIMEOUT_S")
    return WaitTiming(total_s=total_s, request_s=request_s, poll_s=poll_s)
