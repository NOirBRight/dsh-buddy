#!/usr/bin/env python3
"""Fullscreen the buddy page onto the 960×400 USB sub-screen."""

from __future__ import annotations

import os
import sys
import urllib.request

os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gtk

try:
    gi.require_version("WebKit", "6.0")
    from gi.repository import WebKit
except ValueError:
    print("WebKitGTK 6 is required (package gir1.2-webkit-6.0)", file=sys.stderr)
    raise

DEFAULT_URL = os.environ.get("DSH_BUDDY_URL", "http://127.0.0.1:3082/buddy")
TARGET_W, TARGET_H = 960, 400


def wait_for_url(url: str, timeout_s: float = 30.0) -> None:
    import time

    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 500:
                    return
                last = f"HTTP {response.status}"
        except Exception as error:  # noqa: BLE001 — probe until the lab host is up
            last = str(error)
        time.sleep(0.4)
    print(f"buddy page not reachable at {url}: {last}", file=sys.stderr)


def pick_monitor(display: Gdk.Display) -> Gdk.Monitor | None:
    monitors = display.get_monitors()
    count = monitors.get_n_items()
    fallback = None
    for index in range(count):
        monitor = monitors.get_item(index)
        geometry = monitor.get_geometry()
        if geometry.width == TARGET_W and geometry.height == TARGET_H:
            return monitor
        if geometry.width <= TARGET_W and geometry.height <= TARGET_H:
            fallback = monitor
    return fallback


class BuddyWindow(Gtk.Window):
    def __init__(self, url: str) -> None:
        super().__init__(title="dsh-buddy")
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_default_size(TARGET_W, TARGET_H)

        view = WebKit.WebView()
        settings = view.get_settings()
        settings.set_enable_write_console_messages_to_stdout(True)
        view.load_uri(url)
        self.set_child(view)

        self.connect("realize", self._on_realize)

    def _on_realize(self, _window: Gtk.Window) -> None:
        surface = self.get_surface()
        display = self.get_display()
        monitor = pick_monitor(display)
        if monitor is None:
            print("no 960x400 monitor found; staying on the current output", file=sys.stderr)
            self.fullscreen()
            return
        if hasattr(self, "fullscreen_on_monitor"):
            self.fullscreen_on_monitor(monitor)
        elif surface is not None and hasattr(surface, "fullscreen_on_monitor"):
            surface.fullscreen_on_monitor(monitor)
        else:
            geometry = monitor.get_geometry()
            self.set_default_size(geometry.width, geometry.height)
            self.fullscreen()


def main() -> int:
    wait_for_url(DEFAULT_URL)
    app = Gtk.Application(application_id="local.dsh.buddy")

    def on_activate(application: Gtk.Application) -> None:
        window = BuddyWindow(DEFAULT_URL)
        application.add_window(window)
        window.present()

    app.connect("activate", on_activate)
    return app.run(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
