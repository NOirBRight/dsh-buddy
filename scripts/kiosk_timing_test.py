#!/usr/bin/env python3
"""Tests for the validated kiosk reachability timing configuration."""

from __future__ import annotations

import unittest

from scripts.kiosk_timing import (
    DEFAULT_WAIT_POLL_S,
    DEFAULT_WAIT_REQUEST_TIMEOUT_S,
    DEFAULT_WAIT_TIMEOUT_S,
    load_wait_timing,
)


class WaitTimingTests(unittest.TestCase):
    def test_defaults_are_stable(self) -> None:
        self.assertEqual(
            load_wait_timing({}),
            load_wait_timing(
                {
                    "DSH_BUDDY_WAIT_TIMEOUT_S": str(DEFAULT_WAIT_TIMEOUT_S),
                    "DSH_BUDDY_WAIT_REQUEST_TIMEOUT_S": str(DEFAULT_WAIT_REQUEST_TIMEOUT_S),
                    "DSH_BUDDY_WAIT_POLL_S": str(DEFAULT_WAIT_POLL_S),
                }
            ),
        )

    def test_accepts_bounded_values(self) -> None:
        timing = load_wait_timing(
            {
                "DSH_BUDDY_WAIT_TIMEOUT_S": "10",
                "DSH_BUDDY_WAIT_REQUEST_TIMEOUT_S": "1.5",
                "DSH_BUDDY_WAIT_POLL_S": "0.25",
            }
        )
        self.assertEqual((timing.total_s, timing.request_s, timing.poll_s), (10.0, 1.5, 0.25))

    def test_rejects_non_positive_non_finite_and_over_bound_values(self) -> None:
        for name, value in (
            ("DSH_BUDDY_WAIT_TIMEOUT_S", "0"),
            ("DSH_BUDDY_WAIT_REQUEST_TIMEOUT_S", "-1"),
            ("DSH_BUDDY_WAIT_POLL_S", "nan"),
            ("DSH_BUDDY_WAIT_POLL_S", "inf"),
            ("DSH_BUDDY_WAIT_TIMEOUT_S", "300.1"),
            ("DSH_BUDDY_WAIT_REQUEST_TIMEOUT_S", "30.1"),
            ("DSH_BUDDY_WAIT_POLL_S", "30.1"),
        ):
            with self.subTest(name=name, value=value):
                with self.assertRaises(ValueError):
                    load_wait_timing({name: value})

    def test_rejects_durations_longer_than_total(self) -> None:
        for name in ("DSH_BUDDY_WAIT_REQUEST_TIMEOUT_S", "DSH_BUDDY_WAIT_POLL_S"):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    load_wait_timing(
                        {
                            "DSH_BUDDY_WAIT_TIMEOUT_S": "1",
                            name: "1.1",
                        }
                    )


if __name__ == "__main__":
    unittest.main()
