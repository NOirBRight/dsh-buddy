#!/usr/bin/env python3
"""Fullscreen the buddy page onto the 960×400 USB sub-screen."""

from __future__ import annotations

import os
import sys
import time
import urllib.request

os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")

import gi

DEFAULT_URL = os.environ.get("DSH_BUDDY_URL", "http://127.0.0.1:3082/buddy")
TARGET_W, TARGET_H = 960, 400


def wait_for_url(url: str, timeout_s: float = 30.0) -> None:
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


def gtk4_webkit6():
    gi.require_version("Gtk", "4.0")
    gi.require_version("Gdk", "4.0")
    gi.require_version("WebKit", "6.0")
    from gi.repository import Gdk, Gtk, WebKit

    def pick_monitor(display: Gdk.Display):
        monitors = display.get_monitors()
        fallback = None
        for index in range(monitors.get_n_items()):
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
            view.get_settings().set_enable_write_console_messages_to_stdout(True)
            view.load_uri(url)
            self.set_child(view)
            self.connect("realize", self._on_realize)

        def _on_realize(self, _window: Gtk.Window) -> None:
            display = self.get_display()
            monitor = pick_monitor(display)
            if monitor is None:
                print("no 960x400 monitor found; staying on the current output", file=sys.stderr)
                self.fullscreen()
                return
            self.fullscreen_on_monitor(monitor)

    wait_for_url(DEFAULT_URL)
    app = Gtk.Application(application_id="local.dsh.buddy")

    def on_activate(application: Gtk.Application) -> None:
        window = BuddyWindow(DEFAULT_URL)
        application.add_window(window)
        window.present()

    app.connect("activate", on_activate)
    return app.run(sys.argv)


def gtk3_webkit2():
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import Gdk, Gtk, WebKit2

    def pick_monitor_index(display: Gdk.Display) -> int | None:
        fallback = None
        for index in range(display.get_n_monitors()):
            geometry = display.get_monitor(index).get_geometry()
            if geometry.width == TARGET_W and geometry.height == TARGET_H:
                return index
            if geometry.width <= TARGET_W and geometry.height <= TARGET_H:
                fallback = index
        return fallback

    class BuddyWindow(Gtk.Window):
        def __init__(self, url: str) -> None:
            super().__init__(title="dsh-buddy")
            self.set_decorated(False)
            self.set_resizable(False)
            self.set_default_size(TARGET_W, TARGET_H)
            view = WebKit2.WebView()
            view.get_settings().set_enable_write_console_messages_to_stdout(True)
            view.load_uri(url)
            self.add(view)
            self.connect("realize", self._on_realize)

        def _on_realize(self, _window: Gtk.Window) -> None:
            display = self.get_display()
            index = pick_monitor_index(display)
            screen = display.get_default_screen()
            if index is None:
                print("no 960x400 monitor found; staying on the current output", file=sys.stderr)
                self.fullscreen()
                return
            geometry = display.get_monitor(index).get_geometry()
            print(f"fullscreen on monitor {index} {geometry.width}x{geometry.height}+{geometry.x}+{geometry.y}", file=sys.stderr)
            self.fullscreen_on_monitor(screen, index)

    wait_for_url(DEFAULT_URL)
    window = BuddyWindow(DEFAULT_URL)
    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    Gtk.main()
    return 0


def main() -> int:
    try:
        gi.require_version("WebKit", "6.0")
    except ValueError:
        return gtk3_webkit2()
    return gtk4_webkit6()


if __name__ == "__main__":
    raise SystemExit(main())
