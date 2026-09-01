#!/usr/bin/env python3
"""Tests for the token-safe Chromium command builder."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import signal
import socket
import stat
import subprocess
import sys
import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def fixture_cookie_name(authority: str) -> str:
    """Derive the cookie name used by the pinned Connection fixture."""
    digest = hashlib.sha256(authority.encode("utf-8")).digest()
    suffix = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return "dsh-auth-" + suffix


FIXTURE_COOKIE_NAME = fixture_cookie_name("example.com:8443")

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from kiosk_chrome import (
    _AuthenticationWait,
    _BuddyNavigationWait,
    _MAX_JSON_LIST_BYTES,
    _browser_command,
    _browser_environment,
    _cleanup_process,
    _connect_pipe,
    _connect_websocket,
    _PipeConnection,
    _pipe_command,
    _cookie_committed_for_origin,
    _ensure_private_profile,
    _official_cookie_name,
    _profile_path,
    _prepare_devtools_pipe,
    _launch,
    _wait_for_page,
    _read_exact,
    _receive_frame,
    _send_frame,
    _signal_process_tree,
)
from kiosk_timing import WaitTiming
from kiosk_urls import validate_launch_urls


class ChromiumCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.urls = validate_launch_urls(
            "https://example.com:8443/?token=" + "A" * 43,
            "https://example.com:8443/buddy",
        )

    def test_command_starts_on_blank_page_without_token(self) -> None:
        command = _browser_command("/usr/bin/chromium", self.urls, "/tmp/profile", 1234, [])
        self.assertIn("--app=about:blank", command)
        self.assertIn("--remote-debugging-pipe", command)
        self.assertIn("--disable-extensions", command)
        self.assertFalse(any(argument.startswith("--remote-debugging-port") for argument in command))
        self.assertNotIn(self.urls.authenticate_url, command)
        self.assertNotIn("https://example.com:8443/buddy", command)
        self.assertFalse(any("secret_token" in argument for argument in command))

    def test_command_rejects_extra_arguments_outside_allowlist(self) -> None:
        protected = (
            "--app=https://evil.example/",
            "--user-data-dir=/tmp/other",
            "--profile-directory=Profile 2",
            "--remote-debugging-address=0.0.0.0",
            "--remote-debugging-port=9999",
            "--proxy-server=http://evil.example",
            "--proxy-pac-url=http://evil.example/proxy.pac",
            "--host-resolver-rules=MAP * 127.0.0.1",
            "--ignore-certificate-errors",
            "--disable-web-security",
            "--load-extension=/tmp/extension",
            "--disable-extensions-except=/tmp/extension",
            "--disable-extensions",
            "--load-and-launch-app=/tmp/app",
            "--disk-cache-dir=/tmp/cache",
            "--js-flags=--expose-gc",
            "--renderer-cmd-prefix=/bin/evil",
            "--no-sandbox",
            "--disable-features=NetworkService",
            "--window-size=1,1",
        )
        for argument in protected:
            with self.subTest(argument=argument):
                with self.assertRaises(ValueError):
                    _browser_command("/usr/bin/chromium", self.urls, "/tmp/profile", 1234, [argument])

    def test_command_rejects_token_in_extra_arguments(self) -> None:
        with self.assertRaises(ValueError):
            _browser_command(
                "/usr/bin/chromium",
                self.urls,
                "/tmp/profile",
                1234,
                ["--diagnostic=" + self.urls.authenticate_url.split("token=", 1)[1]],
            )

    def test_command_rejects_non_flag_extra_arguments(self) -> None:
        with self.assertRaises(ValueError):
            _browser_command("/usr/bin/chromium", self.urls, "/tmp/profile", 1234, ["https://evil.example/"])

    def test_devtools_pipe_uses_null_delimited_messages(self) -> None:
        payload = b"{\"id\":1}"

        class Stream:
            def __init__(self, data=b"") -> None:
                self.data = bytearray(data)
                self.writes = []
                self.closed = False

            def read(self, size):
                chunk = bytes(self.data[:size])
                del self.data[:size]
                return chunk

            def write(self, value):
                self.writes.append(value)

            def flush(self):
                return None

            def close(self):
                self.closed = True

        stdin = Stream()
        stdout = Stream(payload + b"\x00")
        process = type("Process", (), {"stdin": stdin, "stdout": stdout})()
        connection = _PipeConnection(process)
        try:
            self.assertEqual(connection.receive(time.monotonic() + 1), payload)
            connection.send(b"{}")
            self.assertEqual(stdin.writes, [b"{}\x00"])
        finally:
            connection.close()
        self.assertTrue(stdin.closed)
        self.assertTrue(stdout.closed)

    def test_pipe_command_binds_session_and_delivers_events(self) -> None:
        class Connection:
            def __init__(self) -> None:
                self.sent = []
                self.messages = [
                    json.dumps({"sessionId": "session", "method": "Page.loadEventFired", "params": {"timestamp": 1}}).encode("utf-8"),
                    json.dumps({"id": 8, "sessionId": "session", "result": {"ok": True}}).encode("utf-8"),
                ]

            def send(self, payload):
                self.sent.append(json.loads(payload.decode("utf-8")))

            def receive(self, _deadline):
                return self.messages.pop(0)

            def close(self):
                return None

        connection = Connection()
        events = []
        result = _pipe_command(
            connection,
            8,
            "Page.enable",
            WaitTiming(total_s=1, request_s=0.1, poll_s=0.01),
            session_id="session",
            on_event=events.append,
        )
        self.assertEqual(result, {"ok": True})
        self.assertEqual(events[0]["method"], "Page.loadEventFired")
        self.assertEqual(connection.sent, [{"id": 8, "method": "Page.enable", "sessionId": "session"}])

    def test_connect_pipe_selects_and_attaches_a_page_target(self) -> None:
        class Connection:
            def close(self):
                return None

        connection = Connection()
        responses = [
            {"targetInfos": [{"type": "page", "targetId": "target"}]},
            {"sessionId": "session"},
        ]
        timing = WaitTiming(total_s=1, request_s=0.1, poll_s=0.01)
        with patch("kiosk_chrome._PipeConnection", return_value=connection), patch("kiosk_chrome._pipe_command", side_effect=responses) as command:
            result = _connect_pipe(object(), timing)
        self.assertEqual(result, (connection, "session"))
        self.assertEqual(command.call_args_list[0].args[2], "Target.getTargets")
        self.assertEqual(command.call_args_list[1].args[2], "Target.attachToTarget")
        self.assertEqual(command.call_args_list[1].args[4], {"targetId": "target", "flatten": True})

    def test_cdp_endpoint_is_pinned_to_loopback_and_chosen_port(self) -> None:
        process = type("Process", (), {"poll": lambda _self: None})()
        timing = WaitTiming(total_s=1, request_s=0.1, poll_s=0.01)
        valid = io.StringIO(json.dumps([{
            "type": "page",
            "webSocketDebuggerUrl": "ws://127.0.0.1:4321/devtools/page/ok",
        }]))
        with patch("kiosk_chrome.urllib.request.urlopen", return_value=valid):
            self.assertEqual(_wait_for_page(4321, process, timing), "ws://127.0.0.1:4321/devtools/page/ok")

        for endpoint in (
            "ws://evil.example:4321/devtools/page/evil",
            "ws://127.0.0.1:4322/devtools/page/wrong-port",
            "http://127.0.0.1:4321/devtools/page/wrong-scheme",
            "ws://127.0.0.1:4321/devtools/browser/wrong-target",
            "ws://127.0.0.1:4321/devtools/page/",
            "ws://127.0.0.1:4321/devtools/page/one/two",
        ):
            with self.subTest(endpoint=endpoint):
                response = io.StringIO(json.dumps([{
                    "type": "page",
                    "webSocketDebuggerUrl": endpoint,
                }]))
                with patch("kiosk_chrome.urllib.request.urlopen", return_value=response):
                    with self.assertRaises(RuntimeError):
                        _wait_for_page(4321, process, timing)

        with patch("kiosk_chrome.socket.create_connection") as create_connection:
            for endpoint in (
                "ws://127.0.0.1:4322/devtools/page/wrong-port",
                "ws://127.0.0.1:4321/devtools/browser/wrong-target",
                "ws://127.0.0.1:4321/devtools/page/",
            ):
                with self.subTest(endpoint=endpoint):
                    with self.assertRaises(RuntimeError):
                        _connect_websocket(endpoint, timing, 4321)
            create_connection.assert_not_called()

    def test_json_list_body_is_bounded(self) -> None:
        process = type("Process", (), {"poll": lambda _self: None})()
        response = io.BytesIO(b"x" * (_MAX_JSON_LIST_BYTES + 1))
        with patch("kiosk_chrome.urllib.request.urlopen", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "oversized"):
                _wait_for_page(4321, process, WaitTiming(total_s=1, request_s=0.1, poll_s=0.01))

    def test_websocket_handshake_requires_rfc6455_response_headers(self) -> None:
        class HandshakeSocket:
            def __init__(self, mutate) -> None:
                self.closed = False
                self.response = b''
                self.mutate = mutate

            def sendall(self, payload):
                key = next(line.split(b': ', 1)[1] for line in payload.split(b'\r\n') if line.startswith(b'Sec-WebSocket-Key: ')).decode('ascii')
                accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode('ascii')).digest()).decode('ascii')
                self.response = self.mutate(accept).encode('ascii')

            def recv(self, size):
                chunk, self.response = self.response[:size], self.response[size:]
                return chunk

            def close(self):
                self.closed = True

            def settimeout(self, _timeout):
                return None

        valid = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n'
        cases = (
            lambda accept: valid.format(accept=accept).replace('Upgrade: WebSocket\r\n', ''),
            lambda accept: valid.format(accept=accept).replace('Connection: keep-alive, Upgrade\r\n', ''),
            lambda accept: valid.format(accept='wrong'),
            lambda accept: valid.format(accept=accept).replace('101 Switching Protocols', '200 OK'),
        )
        for mutate in cases:
            connection = HandshakeSocket(mutate)
            with patch('kiosk_chrome.socket.create_connection', return_value=connection):
                with self.assertRaisesRegex(RuntimeError, 'handshake failed'):
                    _connect_websocket('ws://127.0.0.1:1234/devtools/page/test', WaitTiming(total_s=1, request_s=0.1, poll_s=0.01), 1234)
            self.assertTrue(connection.closed)

        connection = HandshakeSocket(lambda accept: valid.format(accept=accept))
        with patch('kiosk_chrome.socket.create_connection', return_value=connection):
            self.assertIs(_connect_websocket('ws://127.0.0.1:1234/devtools/page/test', WaitTiming(total_s=1, request_s=0.1, poll_s=0.01), 1234), connection)
        connection.close()

    def test_websocket_handshake_failures_close_connection(self) -> None:
        class HandshakeSocket:
            def __init__(self, recv_error=None) -> None:
                self.closed = False
                self.recv_error = recv_error

            def sendall(self, _payload):
                if self.recv_error == "send":
                    raise OSError("send failed")

            def recv(self, _size):
                if isinstance(self.recv_error, BaseException):
                    raise self.recv_error
                return b""

            def close(self):
                self.closed = True

            def settimeout(self, _timeout):
                return None

        send_socket = HandshakeSocket("send")
        with patch("kiosk_chrome.socket.create_connection", return_value=send_socket):
            with self.assertRaises(OSError):
                _connect_websocket("ws://127.0.0.1:1234/devtools/page/test", WaitTiming(total_s=1, request_s=0.1, poll_s=0.01), 1234)
        self.assertTrue(send_socket.closed)

        receive_socket = HandshakeSocket(ConnectionResetError("recv failed"))
        with patch("kiosk_chrome.socket.create_connection", return_value=receive_socket):
            with self.assertRaises(ConnectionResetError):
                _connect_websocket("ws://127.0.0.1:1234/devtools/page/test", WaitTiming(total_s=1, request_s=0.1, poll_s=0.01), 1234)
        self.assertTrue(receive_socket.closed)

    def test_socket_send_and_receive_failures_close_connection(self) -> None:
        class BrokenSocket:
            def __init__(self, recv_error=None) -> None:
                self.closed = False
                self.recv_error = recv_error

            def sendall(self, _payload):
                raise OSError("send failed")

            def recv(self, _size):
                if self.recv_error is not None:
                    raise self.recv_error
                return b""

            def close(self):
                self.closed = True

            def settimeout(self, _timeout):
                return None

        send_socket = BrokenSocket()
        with self.assertRaises(OSError):
            _send_frame(send_socket, b"payload")
        self.assertTrue(send_socket.closed)

        receive_socket = BrokenSocket(ConnectionResetError("recv failed"))
        with self.assertRaises(ConnectionResetError):
            _read_exact(receive_socket, 1, time.monotonic() + 1)
        self.assertTrue(receive_socket.closed)

        empty_socket = BrokenSocket()
        with self.assertRaises(ConnectionError):
            _read_exact(empty_socket, 1, time.monotonic() + 1)
        self.assertTrue(empty_socket.closed)

    def test_oversized_frame_closes_connection(self) -> None:
        class FrameSocket:
            def __init__(self) -> None:
                self.closed = False
                self.chunks = [bytes((0x81, 0x7F)), (16 * 1024 * 1024 + 1).to_bytes(8, "big")]

            def recv(self, _size):
                return self.chunks.pop(0)

            def close(self):
                self.closed = True

            def settimeout(self, _timeout):
                return None

        connection = FrameSocket()
        with self.assertRaises(RuntimeError):
            _receive_frame(connection, time.monotonic() + 1)
        self.assertTrue(connection.closed)

    def test_slow_partial_frame_honors_total_deadline(self) -> None:
        class SlowFrameSocket:
            def __init__(self) -> None:
                self.closed = False
                self.reads = 0
                self.timeouts = []

            def settimeout(self, timeout) -> None:
                self.timeouts.append(timeout)

            def recv(self, _size):
                self.reads += 1
                return bytes((0x81, 0x05)) if self.reads == 1 else b"x"

            def close(self) -> None:
                self.closed = True

        connection = SlowFrameSocket()
        with patch("kiosk_chrome.time.monotonic", side_effect=[0.0, 0.4, 0.8, 1.1]):
            with self.assertRaises(socket.timeout):
                _receive_frame(connection, 1.0)
        self.assertTrue(connection.closed)
        self.assertTrue(connection.timeouts)
        self.assertTrue(all(timeout is not None and timeout > 0 for timeout in connection.timeouts))

    def test_process_tree_cleanup_uses_process_group_signals(self) -> None:
        process = type("Process", (), {"pid": 4321, "poll": lambda self: None})()
        with patch("kiosk_chrome.os.name", "posix"), patch("kiosk_chrome.os.getpgid", return_value=4321), patch("kiosk_chrome.os.killpg") as killpg:
            _signal_process_tree(process, signal.SIGTERM, lambda: self.fail("unexpected process-only fallback"), 4321)
        killpg.assert_called_once_with(4321, signal.SIGTERM)

    def test_fixture_cookie_name_is_base64url_sha256(self) -> None:
        self.assertEqual(FIXTURE_COOKIE_NAME, "dsh-auth-4gghrT0CecNhjBwGR9wRlnT3YJKOzzLA9-LdR1fX-3A")
        self.assertEqual(_official_cookie_name(self.urls.authenticate_url), FIXTURE_COOKIE_NAME)
        suffix = FIXTURE_COOKIE_NAME.removeprefix("dsh-auth-")
        self.assertEqual(len(suffix), 43)
        self.assertRegex(suffix, r"^[A-Za-z0-9_-]+$")
        self.assertIn("-", suffix)

    def test_authentication_wait_requires_root_response_cookie_commit_and_load(self) -> None:
        wait = _AuthenticationWait(self.urls.authenticate_url)
        wait.bind_navigate_response({"result": {"frameId": "main"}})
        wait.consume({
            "method": "Network.requestWillBeSent",
            "params": {"requestId": "auth", "frameId": "main", "request": {"url": self.urls.authenticate_url}},
        })
        wait.consume({
            "method": "Network.responseReceived",
            "params": {"requestId": "auth", "response": {"url": "https://example.com:8443/", "status": 200}},
        })
        wait.consume({
            "method": "Network.responseReceivedExtraInfo",
            "params": {"requestId": "auth", "headers": {"Set-Cookie": f"{FIXTURE_COOKIE_NAME}=opaque; Path=/; HttpOnly; SameSite=Strict"}},
        })
        self.assertFalse(wait.complete())
        wait.consume({"method": "Network.loadingFinished", "params": {"requestId": "auth"}})
        self.assertFalse(wait.complete())
        wait.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
        self.assertTrue(wait.complete())

    def test_authentication_wait_accepts_token_query_redirect_response(self) -> None:
        wait = _AuthenticationWait(self.urls.authenticate_url)
        wait.bind_navigate_response({"result": {"frameId": "main"}})
        wait.consume({"method": "Network.requestWillBeSent", "params": {"requestId": "auth", "frameId": "main", "request": {"url": self.urls.authenticate_url}}})
        wait.consume({"method": "Network.responseReceived", "params": {"requestId": "auth", "response": {"url": self.urls.authenticate_url, "status": 303}}})
        wait.consume({"method": "Network.responseReceived", "params": {"requestId": "auth", "response": {"url": "https://example.com:8443/", "status": 200}}})
        wait.consume({"method": "Network.responseReceivedExtraInfo", "params": {"requestId": "auth", "headers": {"Set-Cookie": f"{FIXTURE_COOKIE_NAME}=opaque; Path=/; HttpOnly; SameSite=Strict"}}})
        wait.consume({"method": "Network.loadingFinished", "params": {"requestId": "auth"}})
        wait.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
        self.assertTrue(wait.complete())

    def test_authentication_wait_accepts_only_official_cookie_among_set_cookie_headers(self) -> None:
        wait = _AuthenticationWait(self.urls.authenticate_url)
        wait.bind_navigate_response({"result": {"frameId": "main"}})
        wait.consume({"method": "Network.requestWillBeSent", "params": {"requestId": "auth", "frameId": "main", "request": {"url": self.urls.authenticate_url}}})
        wait.consume({"method": "Network.responseReceived", "params": {"requestId": "auth", "response": {"url": "https://example.com:8443/", "status": 200}}})
        wait.consume({
            "method": "Network.responseReceivedExtraInfo",
            "params": {"requestId": "auth", "headers": {"Set-Cookie": ["_ga=tracking; Path=/", f"{fixture_cookie_name('other.example.com:8443')}=wrong; Path=/; HttpOnly; SameSite=Strict", f"{FIXTURE_COOKIE_NAME}=opaque; Path=/; HttpOnly; SameSite=Strict"]}},
        })
        wait.consume({"method": "Network.loadingFinished", "params": {"requestId": "auth"}})
        wait.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
        self.assertEqual(wait.cookie_names, frozenset({FIXTURE_COOKIE_NAME}))
        self.assertTrue(wait.complete())

    def test_authentication_wait_ignores_an_iframe_auth_load(self) -> None:
        wait = _AuthenticationWait(self.urls.authenticate_url)
        wait.bind_navigate_response({"result": {"frameId": "main"}})
        wait.consume({"method": "Network.requestWillBeSent", "params": {"requestId": "iframe", "frameId": "child", "request": {"url": self.urls.authenticate_url}}})
        wait.consume({"method": "Network.responseReceived", "params": {"requestId": "iframe", "response": {"url": "https://example.com:8443/", "status": 200}}})
        wait.consume({"method": "Network.responseReceivedExtraInfo", "params": {"requestId": "iframe", "headers": {"Set-Cookie": f"{FIXTURE_COOKIE_NAME}=opaque; Path=/; HttpOnly; SameSite=Strict"}}})
        wait.consume({"method": "Network.loadingFinished", "params": {"requestId": "iframe"}})
        wait.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
        self.assertFalse(wait.complete())

    def test_authentication_wait_rejects_tracking_and_malformed_cookies(self) -> None:
        for cookie_header in (
            "_ga=tracking; Path=/",
            "dsh-auth-=empty-suffix; Path=/",
            "dsh-auth-+=punctuation; Path=/",
            "dsh-auth-abc.def=wrong-alphabet; Path=/",
            "dsh-auth-" + "a" * 64 + "=wrong-length; Path=/; HttpOnly; SameSite=Strict",
            f"{FIXTURE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict",
            f"{FIXTURE_COOKIE_NAME}=opaque; Path=/",
            f"{FIXTURE_COOKIE_NAME}=opaque; Path=/; HttpOnly",
            f"{FIXTURE_COOKIE_NAME}=opaque; Path=/; SameSite=Strict",
            f"{FIXTURE_COOKIE_NAME}=opaque; Domain=example.com; Path=/; HttpOnly; SameSite=Strict",
        ):
            with self.subTest(cookie_header=cookie_header):
                wait = _AuthenticationWait(self.urls.authenticate_url)
                wait.bind_navigate_response({"result": {"frameId": "main"}})
                wait.consume({
                    "method": "Network.requestWillBeSent",
                    "params": {"requestId": "auth", "frameId": "main", "request": {"url": self.urls.authenticate_url}},
                })
                wait.consume({
                    "method": "Network.responseReceived",
                    "params": {"requestId": "auth", "response": {"url": "https://example.com:8443/", "status": 200}},
                })
                wait.consume({
                    "method": "Network.responseReceivedExtraInfo",
                    "params": {"requestId": "auth", "headers": {"Set-Cookie": cookie_header}},
                })
                wait.consume({"method": "Network.loadingFinished", "params": {"requestId": "auth"}})
                wait.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
                self.assertEqual(wait.cookie_names, frozenset())
                self.assertFalse(wait.complete())

    def test_cookie_commit_only_uses_the_root_token_request(self) -> None:
        wait = _AuthenticationWait(self.urls.authenticate_url)
        wait.bind_navigate_response({"result": {"frameId": "main"}})
        wait.consume({"method": "Network.requestWillBeSent", "params": {"requestId": "auth", "frameId": "main", "request": {"url": self.urls.authenticate_url}}})
        wait.consume({"method": "Network.responseReceived", "params": {"requestId": "auth", "response": {"url": "https://example.com:8443/", "status": 200}}})
        wait.consume({
            "method": "Network.responseReceivedExtraInfo",
            "params": {"requestId": "other", "headers": {"Set-Cookie": f"{FIXTURE_COOKIE_NAME}=unrelated; Path=/; HttpOnly; SameSite=Strict"}},
        })
        wait.consume({"method": "Network.loadingFinished", "params": {"requestId": "other"}})
        wait.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
        self.assertEqual(wait.cookie_names, frozenset({FIXTURE_COOKIE_NAME}))
        self.assertFalse(wait.complete())

    def test_cookie_verifier_rejects_unrelated_and_malformed_names(self) -> None:
        for name in ("_ga", "session-id", "dsh-auth-!", "dsh-auth-abc.def"):
            with self.subTest(name=name):
                result = {"cookies": [{"name": name, "domain": "example.com", "path": "/"}]}
                self.assertFalse(_cookie_committed_for_origin(result, self.urls.authenticate_url, frozenset({name})))

    def test_cookie_verifier_requires_value_and_security_attributes(self) -> None:
        valid = {"name": FIXTURE_COOKIE_NAME, "value": "opaque", "domain": "example.com", "path": "/", "httpOnly": True, "sameSite": "Strict"}
        self.assertTrue(_cookie_committed_for_origin({"cookies": [valid]}, self.urls.authenticate_url, frozenset({FIXTURE_COOKIE_NAME})))
        wrong_name = fixture_cookie_name("other.example.com:8443")
        self.assertFalse(_cookie_committed_for_origin({"cookies": [{**valid, "name": wrong_name}]}, self.urls.authenticate_url, frozenset({wrong_name})))
        for field, value in (("value", ""), ("value", '""'), ("httpOnly", False), ("sameSite", "Lax"), ("path", "/buddy"), ("domain", ".example.com"), ("domain", "sub.example.com"), ("domain", "other.example.com"), ("domain", "example.org"), ("hostOnly", False)):
            with self.subTest(field=field):
                invalid = {**valid, field: value}
                self.assertFalse(_cookie_committed_for_origin({"cookies": [invalid]}, self.urls.authenticate_url, frozenset({FIXTURE_COOKIE_NAME})))

    def test_buddy_navigation_does_not_accept_a_subframe_response(self) -> None:
        wait = _BuddyNavigationWait(self.urls.buddy_url)
        wait.consume({"method": "Network.requestWillBeSent", "params": {"requestId": "main", "frameId": "main", "request": {"url": self.urls.buddy_url}}})
        wait.consume({"method": "Network.responseReceived", "params": {"requestId": "main", "response": {"url": self.urls.buddy_url, "status": 401, "type": "Document", "frameId": "main"}}})
        wait.consume({"method": "Network.requestWillBeSent", "params": {"requestId": "child", "frameId": "child", "request": {"url": self.urls.buddy_url}}})
        wait.consume({"method": "Network.responseReceived", "params": {"requestId": "child", "response": {"url": self.urls.buddy_url, "status": 200, "type": "Document", "frameId": "child"}}})
        wait.consume({"method": "Page.frameNavigated", "params": {"frame": {"id": "child", "parentId": "main", "url": self.urls.buddy_url}}})
        wait.consume({"method": "Page.frameNavigated", "params": {"frame": {"id": "main", "url": self.urls.buddy_url}}})
        wait.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
        self.assertFalse(wait.complete())

    def test_buddy_navigation_requires_exact_same_origin_path_and_2xx(self) -> None:
        without_response = _BuddyNavigationWait(self.urls.buddy_url)
        without_response.consume({"method": "Page.frameNavigated", "params": {"frame": {"url": self.urls.buddy_url}}})
        without_response.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
        self.assertFalse(without_response.complete())

        for status in (401, 404, 302):
            with self.subTest(status=status):
                wait = _BuddyNavigationWait(self.urls.buddy_url)
                wait.consume({"method": "Network.requestWillBeSent", "params": {"requestId": "buddy", "request": {"url": self.urls.buddy_url}}})
                wait.consume({"method": "Network.responseReceived", "params": {"requestId": "buddy", "response": {"url": self.urls.buddy_url, "status": status, "type": "Document"}}})
                wait.consume({"method": "Page.frameNavigated", "params": {"frame": {"url": self.urls.buddy_url}}})
                wait.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
                self.assertFalse(wait.complete())

        success = _BuddyNavigationWait(self.urls.buddy_url)
        success.consume({"method": "Network.requestWillBeSent", "params": {"requestId": "buddy", "request": {"url": self.urls.buddy_url}}})
        success.consume({"method": "Network.responseReceived", "params": {"requestId": "buddy", "response": {"url": self.urls.buddy_url, "status": 200, "type": "Document"}}})
        success.consume({"method": "Page.frameNavigated", "params": {"frame": {"url": self.urls.buddy_url}}})
        success.consume({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
        self.assertTrue(success.complete())

    def test_ordered_launch_uses_blank_auth_cookie_then_buddy(self) -> None:
        calls = []

        class FakeProcess:
            def __init__(self) -> None:
                self.alive = True
                self.command = None

            def poll(self):
                return None if self.alive else 0

            def wait(self, timeout=None):
                self.alive = False
                return 0

            def terminate(self):
                self.alive = False

            def kill(self):
                self.alive = False

        class FakeConnection:
            def __enter__(self):
                return self

            def __exit__(self, _type, _value, _traceback):
                return False

        process = FakeProcess()

        def command(_connection, _command_id, method, _timing, params=None, session_id=None, on_event=None, complete=None, on_response=None, deadline=None):
            calls.append((method, params))
            if method == "Page.navigate" and params["url"] == self.urls.authenticate_url:
                on_event({"method": "Network.requestWillBeSent", "params": {"requestId": "auth", "frameId": "main", "request": {"url": self.urls.authenticate_url}}})
                on_event({"method": "Network.responseReceived", "params": {"requestId": "auth", "response": {"url": "https://example.com:8443/", "status": 200}}})
                on_event({"method": "Network.responseReceivedExtraInfo", "params": {"requestId": "auth", "headers": {"set-cookie": f"{FIXTURE_COOKIE_NAME}=opaque; Path=/; HttpOnly; SameSite=Strict"}}})
                on_event({"method": "Network.loadingFinished", "params": {"requestId": "auth"}})
                on_event({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
                on_response({"result": {"frameId": "main"}})
                self.assertTrue(complete())
            elif method == "Page.navigate":
                on_event({"method": "Network.requestWillBeSent", "params": {"requestId": "buddy", "request": {"url": self.urls.buddy_url}}})
                on_event({"method": "Network.responseReceived", "params": {"requestId": "buddy", "response": {"url": self.urls.buddy_url, "status": 200, "type": "Document"}}})
                on_event({"method": "Page.frameNavigated", "params": {"frame": {"url": self.urls.buddy_url}}})
                on_event({"method": "Page.loadEventFired", "params": {"timestamp": 1}})
                self.assertTrue(complete())
            if method == "Network.getAllCookies":
                return {"cookies": [{"name": FIXTURE_COOKIE_NAME, "value": "opaque", "domain": "example.com", "path": "/", "httpOnly": True, "sameSite": "Strict"}]}
            return None

        with patch.dict(os.environ, {"DSH_BUDDY_AUTHENTICATE_URL": self.urls.authenticate_url}, clear=False), patch("kiosk_chrome._profile_path", return_value="/tmp/profile"), patch("kiosk_chrome._browser_path", return_value="/usr/bin/chromium"), patch("kiosk_chrome.subprocess.Popen", return_value=process) as popen, patch("kiosk_chrome._connect_pipe", return_value=(FakeConnection(), "session")), patch("kiosk_chrome._pipe_command", side_effect=command):
            self.assertEqual(_launch(self.urls, [], WaitTiming(total_s=1, request_s=0.1, poll_s=0.01)), 0)

        popen.assert_called_once()
        self.assertTrue(popen.call_args.kwargs.get("start_new_session"))
        self.assertIs(popen.call_args.kwargs.get("preexec_fn"), _prepare_devtools_pipe)
        self.assertEqual(popen.call_args.kwargs.get("pass_fds"), (3, 4))
        self.assertIs(popen.call_args.kwargs.get("stdin"), subprocess.PIPE)
        self.assertIs(popen.call_args.kwargs.get("stdout"), subprocess.PIPE)
        self.assertEqual(calls[4][1], {"url": self.urls.buddy_url})

    def test_explicit_profile_path_must_be_absolute_before_normalization(self) -> None:
        with patch.dict(os.environ, {"DSH_BUDDY_KIOSK_DATA": "relative/profile"}, clear=False), patch("kiosk_chrome.os.path.abspath", side_effect=AssertionError("abspath must not normalize explicit relative paths")):
            with self.assertRaisesRegex(ValueError, "absolute path"):
                _profile_path()

        with patch.dict(os.environ, {"DSH_BUDDY_KIOSK_DATA": "~/profile"}, clear=False):
            with self.assertRaisesRegex(ValueError, "absolute path"):
                _profile_path()

    def test_profile_path_is_absolute_and_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            profile = Path(temporary) / "profile"
            profile.mkdir(mode=0o755)
            with patch.dict(os.environ, {"DSH_BUDDY_KIOSK_DATA": str(profile)}, clear=False):
                self.assertEqual(_profile_path(), str(profile.absolute()))
            _ensure_private_profile(str(profile))
            self.assertEqual(stat.S_IMODE(profile.stat().st_mode), 0o700)

            created = Path(temporary) / "created"
            _ensure_private_profile(str(created))
            self.assertTrue(created.is_dir())
            self.assertEqual(stat.S_IMODE(created.stat().st_mode), 0o700)

            nested = Path(temporary) / "nested" / "deep" / "created"
            with patch("kiosk_chrome.os.makedirs") as makedirs:
                _ensure_private_profile(str(nested))
            makedirs.assert_not_called()
            self.assertTrue(nested.is_dir())

            linked = Path(temporary) / "linked"
            linked.symlink_to(profile, target_is_directory=True)
            with self.assertRaises(ValueError):
                _ensure_private_profile(str(linked))

            parent_link = Path(temporary) / "parent-link"
            parent_link.symlink_to(temporary, target_is_directory=True)
            with self.assertRaises(ValueError):
                _ensure_private_profile(str(parent_link / "profile"))

            regular = Path(temporary) / "regular"
            regular.write_text("not a profile", encoding="utf-8")
            with self.assertRaises(ValueError):
                _ensure_private_profile(str(regular))

    def test_browser_environment_drops_authentication_values(self) -> None:
        with patch.dict(os.environ, {
            "DSH_BUDDY_AUTHENTICATE_URL": self.urls.authenticate_url,
            "DSH_BUDDY_SECRET_COPY": "prefix-secret_token-suffix",
            "AWS_PROFILE": "default",
            "AWS_SECRET_ACCESS_KEY": "secret",
            "HTTP_PROXY": "http://proxy.example",
            "NPM_TOKEN": "npm-secret",
            "SSH_AUTH_SOCK": "/tmp/agent.sock",
            "GIT_CONFIG_GLOBAL": "/tmp/.gitconfig",
            "NODE_PATH": "/tmp/node_modules",
            "NODE_OPTIONS": "--require=/tmp/inject.js",
            "LC_UNRELATED_SECRET": "locale-secret",
            "LD_LIBRARY_PATH": "/tmp/injected-libraries",
            "LC_TIME": "UTC",
        }, clear=False):
            environment = _browser_environment(self.urls, "/tmp/profile")
        self.assertNotIn("DSH_BUDDY_AUTHENTICATE_URL", environment)
        self.assertNotIn("DSH_BUDDY_SECRET_COPY", environment)
        self.assertNotIn("AWS_PROFILE", environment)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", environment)
        self.assertNotIn("HTTP_PROXY", environment)
        self.assertNotIn("NPM_TOKEN", environment)
        self.assertNotIn("SSH_AUTH_SOCK", environment)
        self.assertNotIn("GIT_CONFIG_GLOBAL", environment)
        self.assertNotIn("NODE_PATH", environment)
        self.assertNotIn("NODE_OPTIONS", environment)
        self.assertNotIn("LC_UNRELATED_SECRET", environment)
        self.assertNotIn("LD_LIBRARY_PATH", environment)
        self.assertEqual(environment["LC_TIME"], "UTC")
        self.assertEqual(environment["HOME"], "/tmp/profile")
        self.assertFalse(any("secret_token" in value for value in environment.values()))
        with self.assertRaises(ValueError):
            _browser_environment(self.urls, "/tmp/" + self.urls.authenticate_url.split("token=", 1)[1] + "-profile")

    def test_cleanup_kills_and_reaps_process_group_tree(self) -> None:
        class ProcessTree:
            pid = 4321

            def __init__(self) -> None:
                self.waits = 0

            def poll(self):
                return None

            def wait(self, timeout=None):
                self.waits += 1
                if self.waits == 1:
                    raise subprocess.TimeoutExpired("chromium", timeout)
                return -9

            def terminate(self):
                self.fail_if_called = True

            def kill(self):
                self.fail_if_called = True

        process = ProcessTree()

        def signal_group(_pid, signal_number):
            if signal_number == 0:
                raise ProcessLookupError

        with patch("kiosk_chrome.os.name", "posix"), patch("kiosk_chrome.os.getpgid", return_value=4321), patch("kiosk_chrome.os.killpg", side_effect=signal_group) as killpg:
            _cleanup_process(process, 0.1)
        self.assertEqual([call.args for call in killpg.call_args_list], [(4321, signal.SIGTERM), (4321, signal.SIGKILL)])
        self.assertEqual(process.waits, 2)
        self.assertFalse(hasattr(process, "fail_if_called"))

    def test_cleanup_does_not_signal_reaped_process_group(self) -> None:
        class ExitedParent:
            pid = 4321

            def poll(self):
                return 0

            def wait(self, timeout=None):
                return 0

            def terminate(self):
                self.fail("must not signal a reused parent PID")

            def kill(self):
                self.fail("must not signal a reused parent PID")

        def signal_group(_pid, signal_number):
            if signal_number == 0:
                raise ProcessLookupError

        with patch("kiosk_chrome.os.name", "posix"), patch("kiosk_chrome.os.killpg", side_effect=signal_group) as killpg:
            _cleanup_process(ExitedParent(), 0.1)
        killpg.assert_not_called()

    def test_cleanup_does_not_group_signal_after_leader_reaps(self) -> None:
        class ReapedAfterTimeout:
            pid = 4321

            def __init__(self) -> None:
                self.reaped = False
                self.waits = 0

            def poll(self):
                return 0 if self.reaped else None

            def wait(self, timeout=None):
                self.waits += 1
                if self.waits == 1:
                    self.reaped = True
                    raise subprocess.TimeoutExpired("chromium", timeout)
                return 0

            def terminate(self):
                self.fail_if_called = True

            def kill(self):
                self.fail("must not kill a reaped leader")

        process = ReapedAfterTimeout()
        with patch("kiosk_chrome.os.name", "posix"), patch("kiosk_chrome.os.getpgid", return_value=4321), patch("kiosk_chrome.os.killpg") as killpg:
            _cleanup_process(process, 0.1)
        self.assertEqual([call.args for call in killpg.call_args_list], [(4321, signal.SIGTERM)])
        self.assertFalse(hasattr(process, "fail_if_called"))

    def test_cleanup_does_not_kill_descendants_after_parent_exit(self) -> None:
        class ExitedParent:
            pid = 4321

            def poll(self):
                return 0

            def wait(self, timeout=None):
                return 0

            def terminate(self):
                self.fail("must not signal a reused parent PID")

            def kill(self):
                self.fail("must not signal a reused parent PID")

        descendants_alive = True

        def signal_group(_pid, signal_number):
            nonlocal descendants_alive
            if signal_number == signal.SIGKILL:
                descendants_alive = False
            elif signal_number == 0 and not descendants_alive:
                raise ProcessLookupError

        with patch("kiosk_chrome.os.name", "posix"), patch("kiosk_chrome.os.killpg", side_effect=signal_group) as killpg:
            _cleanup_process(ExitedParent(), 0)
        self.assertTrue(descendants_alive)
        killpg.assert_not_called()

    def test_cleanup_preserves_kill_and_reap_failures(self) -> None:
        class FailedProcess:
            def poll(self):
                return None

            def terminate(self):
                return None

            def wait(self, timeout=None):
                raise subprocess.TimeoutExpired("chromium", timeout)

            def kill(self):
                raise RuntimeError("kill failed")

        with self.assertRaises(ExceptionGroup) as raised:
            _cleanup_process(FailedProcess(), 0.1)
        self.assertEqual(len(raised.exception.exceptions), 2)
        self.assertIsInstance(raised.exception.exceptions[0], RuntimeError)
        self.assertIsInstance(raised.exception.exceptions[1], subprocess.TimeoutExpired)

    def test_cleanup_force_kills_and_reaps_after_non_timeout_wait_failure(self) -> None:
        calls = []

        class FailedWaitProcess:
            def poll(self):
                return None

            def terminate(self):
                calls.append("terminate")

            def wait(self, timeout=None):
                calls.append("wait")
                if calls.count("wait") == 1:
                    raise RuntimeError("graceful wait failed")
                return -9

            def kill(self):
                calls.append("kill")

        with self.assertRaisesRegex(RuntimeError, "graceful wait failed"):
            _cleanup_process(FailedWaitProcess(), 0.1)
        self.assertEqual(calls, ["terminate", "wait", "kill", "wait"])

    def test_cleanup_kills_and_reaps_after_graceful_timeout(self) -> None:
        calls = []

        class TimedOutProcess:
            def poll(self):
                return None

            def terminate(self):
                calls.append("terminate")

            def wait(self, timeout=None):
                calls.append("wait")
                if calls.count("wait") == 1:
                    raise subprocess.TimeoutExpired("chromium", timeout)
                return -9

            def kill(self):
                calls.append("kill")

        _cleanup_process(TimedOutProcess(), 0.1)
        self.assertEqual(calls, ["terminate", "wait", "kill", "wait"])



if __name__ == "__main__":
    unittest.main()
