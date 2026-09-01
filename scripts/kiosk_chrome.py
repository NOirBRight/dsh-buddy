#!/usr/bin/env python3
"""Authenticate a Chromium profile through local DevTools without token argv or child env."""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import queue
import re
import secrets
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Callable

from kiosk_timing import WaitTiming, load_wait_timing
from kiosk_urls import LaunchUrls, same_origin, validate_launch_urls

TARGET_W, TARGET_H = 960, 400
_CDP_HOST = "127.0.0.1"
_INITIAL_PAGE = "about:blank"
# Unpadded base64url(SHA-256) is exactly 43 characters.
_BASE64URL_COOKIE_NAME = re.compile(r"^dsh-auth-[A-Za-z0-9_-]{43}$")
_MAX_JSON_LIST_BYTES = 1024 * 1024
# The kiosk command owns every Chromium policy flag; user extras have no allowlisted entries.
_ALLOWED_EXTRA_ARGUMENTS = frozenset()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind((_CDP_HOST, 0))
        return int(listener.getsockname()[1])


def _is_devtools_page_path(path: str) -> bool:
    parts = path.split("/")
    if len(parts) != 4 or parts[1:3] != ["devtools", "page"] or not parts[3]:
        return False
    try:
        target_id = urllib.parse.unquote(parts[3], errors="strict")
    except UnicodeDecodeError:
        return False
    return bool(target_id) and not any(character in "/\\" or ord(character) < 0x20 or 0x7F <= ord(character) <= 0x9F for character in target_id)


def _pin_websocket_url(raw_url: str, expected_port: int) -> str:
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        port = parsed.port
    except ValueError as error:
        raise RuntimeError("browser returned an invalid DevTools endpoint") from error
    if (
        parsed.scheme != "ws"
        or parsed.hostname != _CDP_HOST
        or port != expected_port
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.query
        or not _is_devtools_page_path(parsed.path)
    ):
        raise RuntimeError("browser returned an unpinned DevTools endpoint")
    return raw_url


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise socket.timeout("DevTools operation timed out")
    return remaining


def _response_socket(response: object) -> object | None:
    outer = getattr(response, "fp", None)
    inner = getattr(outer, "fp", outer)
    raw = getattr(inner, "raw", inner)
    return getattr(raw, "_sock", None)


def _read_bounded_response(response: object, max_bytes: int, deadline: float) -> bytes:
    read = getattr(response, "read", None)
    if not callable(read):
        raise RuntimeError("browser returned an unreadable DevTools response")
    body = bytearray()
    while len(body) <= max_bytes:
        remaining = _remaining(deadline)
        transport = _response_socket(response)
        settimeout = getattr(transport, "settimeout", None)
        if callable(settimeout):
            settimeout(remaining)
        chunk = read(min(8192, max_bytes - len(body) + 1))
        if isinstance(chunk, str):
            encoded = chunk.encode("utf-8")
        elif isinstance(chunk, (bytes, bytearray, memoryview)):
            encoded = bytes(chunk)
        else:
            raise RuntimeError("browser returned an unreadable DevTools response")
        if not encoded:
            return bytes(body)
        if len(encoded) > max_bytes - len(body):
            raise RuntimeError("browser returned an oversized DevTools response")
        body.extend(encoded)
    raise RuntimeError("browser returned an oversized DevTools response")


def _wait_for_page(port: int, process: subprocess.Popen[bytes], timing: WaitTiming) -> str:
    endpoint = f"http://{_CDP_HOST}:{port}/json/list"
    deadline = time.monotonic() + timing.total_s
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("browser exited before DevTools became available")
        try:
            remaining = _remaining(deadline)
            with urllib.request.urlopen(endpoint, timeout=min(timing.request_s, remaining)) as response:
                body = _read_bounded_response(response, _MAX_JSON_LIST_BYTES, deadline)
            targets = json.loads(body)
            _remaining(deadline)
            if not isinstance(targets, list):
                raise ValueError("browser returned an invalid DevTools target list")
            for target in targets:
                if isinstance(target, dict) and target.get("type") == "page" and isinstance(target.get("webSocketDebuggerUrl"), str):
                    return _pin_websocket_url(target["webSocketDebuggerUrl"], port)
        except (OSError, ValueError, urllib.error.URLError):
            pass
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(timing.poll_s, remaining))
    raise RuntimeError("browser DevTools did not become available")


def _raise_socket_failure(connection: socket.socket, error: BaseException) -> None:
    try:
        connection.close()
    except BaseException as close_error:  # noqa: BLE001 — preserve both I/O and close failures
        raise ExceptionGroup("DevTools socket I/O and close failed", [error, close_error]) from error
    raise error


def _send_bytes(connection: socket.socket, payload: bytes) -> None:
    try:
        connection.sendall(payload)
    except BaseException as error:  # noqa: BLE001 — every send failure closes the socket
        _raise_socket_failure(connection, error)


def _read_exact(connection: socket.socket, size: int, deadline: float) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        try:
            connection.settimeout(_remaining(deadline))
            chunk = connection.recv(size - len(chunks))
        except BaseException as error:  # noqa: BLE001 — every recv failure closes the socket
            _raise_socket_failure(connection, error)
        if not chunk:
            _raise_socket_failure(connection, ConnectionError("DevTools connection closed"))
        chunks.extend(chunk)
    return bytes(chunks)


def _connect_websocket(url: str, timing: WaitTiming, expected_port: int | None = None) -> socket.socket:
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise RuntimeError("browser returned an invalid DevTools endpoint") from error
    if parsed.scheme != "ws" or parsed.hostname != _CDP_HOST or port is None or (expected_port is not None and port != expected_port) or parsed.username is not None or parsed.password is not None or parsed.fragment or parsed.query or not _is_devtools_page_path(parsed.path):
        raise RuntimeError("browser returned an unpinned DevTools endpoint")
    path = parsed.path
    deadline = time.monotonic() + timing.total_s
    connection = socket.create_connection((_CDP_HOST, port), timeout=min(timing.request_s, _remaining(deadline)))
    try:
        connection.settimeout(min(timing.request_s, _remaining(deadline)))
    except BaseException as error:  # noqa: BLE001 — setup failure must close the socket
        _raise_socket_failure(connection, error)
    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {parsed.hostname}:{parsed.port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode("ascii")
    _send_bytes(connection, request)
    header = bytearray()
    while b"\r\n\r\n" not in header:
        try:
            connection.settimeout(min(timing.request_s, _remaining(deadline)))
            chunk = connection.recv(1)
        except socket.timeout:
            _raise_socket_failure(connection, socket.timeout("DevTools handshake timed out"))
        except BaseException as error:  # noqa: BLE001 — every handshake recv failure closes the socket
            _raise_socket_failure(connection, error)
        if not chunk:
            _raise_socket_failure(connection, ConnectionError("DevTools handshake closed"))
        header.extend(chunk)
        if len(header) > 32 * 1024:
            _raise_socket_failure(connection, RuntimeError("DevTools handshake was too large"))
    raw_header = bytes(header[:-4])
    try:
        lines = raw_header.split(b"\r\n")
        status = lines[0].decode("ascii")
        status_parts = status.split(" ", 2)
        if len(status_parts) < 2 or status_parts[0] != "HTTP/1.1" or status_parts[1] != "101":
            raise RuntimeError("DevTools websocket handshake failed")
        response_headers: dict[str, list[str]] = {}
        for raw_line in lines[1:]:
            if not raw_line or raw_line[:1] in (b" ", b"\t") or b":" not in raw_line:
                raise RuntimeError("DevTools websocket handshake failed")
            raw_name, raw_value = raw_line.split(b":", 1)
            name = raw_name.decode("ascii").lower()
            value = raw_value.decode("ascii").strip()
            if not name or any(character.isspace() for character in name):
                raise RuntimeError("DevTools websocket handshake failed")
            response_headers.setdefault(name, []).append(value)
        upgrade = response_headers.get("upgrade", [])
        connection_header = response_headers.get("connection", [])
        accept = response_headers.get("sec-websocket-accept", [])
        expected_accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii"), usedforsecurity=False).digest()).decode("ascii")
        if (
            not any(token.strip().lower() == "websocket" for value in upgrade for token in value.split(","))
            or not any(token.strip().lower() == "upgrade" for value in connection_header for token in value.split(","))
            or accept != [expected_accept]
        ):
            raise RuntimeError("DevTools websocket handshake failed")
    except (UnicodeDecodeError, ValueError):
        _raise_socket_failure(connection, RuntimeError("DevTools websocket handshake failed"))
    except RuntimeError as error:
        _raise_socket_failure(connection, error)
    try:
        connection.settimeout(min(timing.request_s, _remaining(deadline)))
    except BaseException as error:  # noqa: BLE001 — setup failure must close the socket
        _raise_socket_failure(connection, error)
    return connection


def _send_frame(connection: socket.socket, payload: bytes, opcode: int = 1) -> None:
    mask = secrets.token_bytes(4)
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    size = len(masked)
    first = 0x80 | opcode
    if size < 126:
        header = bytes((first, 0x80 | size))
    elif size <= 0xFFFF:
        header = bytes((first, 0x80 | 126)) + size.to_bytes(2, "big")
    else:
        header = bytes((first, 0x80 | 127)) + size.to_bytes(8, "big")
    _send_bytes(connection, header + mask + masked)


def _receive_frame(connection: socket.socket, deadline: float) -> tuple[int, bytes]:
    first, second = _read_exact(connection, 2, deadline)
    opcode = first & 0x0F
    size = second & 0x7F
    if size == 126:
        size = int.from_bytes(_read_exact(connection, 2, deadline), "big")
    elif size == 127:
        size = int.from_bytes(_read_exact(connection, 8, deadline), "big")
    if size > 16 * 1024 * 1024:
        _raise_socket_failure(connection, RuntimeError("DevTools frame was too large"))
    masked = bool(second & 0x80)
    mask = _read_exact(connection, 4, deadline) if masked else b""
    payload = _read_exact(connection, size, deadline)
    if masked:
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return opcode, payload


def _command(
    connection: socket.socket,
    command_id: int,
    method: str,
    timing: WaitTiming,
    params: dict[str, object] | None = None,
    on_event: Callable[[dict[str, object]], None] | None = None,
    complete: Callable[[], bool] | None = None,
    on_response: Callable[[dict[str, object]], None] | None = None,
) -> dict[str, object] | None:
    message: dict[str, object] = {"id": command_id, "method": method}
    if params is not None:
        message["params"] = params
    _send_frame(connection, json.dumps(message, separators=(",", ":")).encode("utf-8"))
    deadline = time.monotonic() + timing.total_s
    response: dict[str, object] | None = None
    response_notified = False
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        try:
            readable, _, _ = select.select([connection], [], [], min(timing.poll_s, remaining))
        except BaseException as error:  # noqa: BLE001 — readiness failure must close the socket
            _raise_socket_failure(connection, error)
        if not readable:
            continue
        try:
            opcode, raw = _receive_frame(connection, deadline)
            _remaining(deadline)
        except socket.timeout as error:
            _raise_socket_failure(connection, error)
        if opcode == 9:
            _send_frame(connection, raw, opcode=10)
            continue
        if opcode == 8:
            raise ConnectionError("DevTools connection closed")
        if opcode != 1:
            continue
        try:
            event = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise RuntimeError("browser returned an invalid DevTools message") from error
        if not isinstance(event, dict):
            raise RuntimeError("browser returned an invalid DevTools message")
        if on_event is not None:
            on_event(event)
        try:
            _remaining(deadline)
        except socket.timeout as error:
            _raise_socket_failure(connection, error)
        if event.get("id") == command_id:
            if "error" in event:
                raise RuntimeError("browser DevTools command failed")
            response = event
        if response is not None:
            if on_response is not None and not response_notified:
                response_notified = True
                on_response(response)
            if complete is None or complete():
                result = response.get("result")
                return result if isinstance(result, dict) else None
    _raise_socket_failure(connection, RuntimeError("browser DevTools command timed out"))


_MAX_PIPE_MESSAGE_BYTES = 16 * 1024 * 1024


class _PipeConnection:
    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        if process.stdin is None or process.stdout is None:
            raise RuntimeError("Chromium DevTools pipe was not opened")
        self._stdin = process.stdin
        self._stdout = process.stdout
        self._messages: queue.Queue[object] = queue.Queue()
        self._closed = False
        self._reader = threading.Thread(target=self._read_messages, name="dsh-kiosk-devtools", daemon=True)
        self._reader.start()

    def _read_messages(self) -> None:
        read = getattr(self._stdout, "read", None)
        if not callable(read):
            self._messages.put(RuntimeError("browser DevTools pipe is unreadable"))
            return
        pending = bytearray()
        try:
            while True:
                chunk = read(8192)
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    raise RuntimeError("browser DevTools pipe returned invalid data")
                if not chunk:
                    raise ConnectionError("browser DevTools pipe closed")
                pending.extend(chunk)
                while True:
                    try:
                        delimiter = pending.index(0)
                    except ValueError:
                        if len(pending) > _MAX_PIPE_MESSAGE_BYTES:
                            raise RuntimeError("browser DevTools pipe message was too large")
                        break
                    payload = bytes(pending[:delimiter])
                    del pending[: delimiter + 1]
                    if len(payload) > _MAX_PIPE_MESSAGE_BYTES:
                        raise RuntimeError("browser DevTools pipe message was too large")
                    self._messages.put(payload)
        except BaseException as error:  # noqa: BLE001 — deliver every reader failure to the command loop
            self._messages.put(error)

    def send(self, payload: bytes) -> None:
        write = getattr(self._stdin, "write", None)
        flush = getattr(self._stdin, "flush", None)
        if not callable(write) or not callable(flush):
            raise RuntimeError("browser DevTools pipe is unwritable")
        try:
            write(payload + b"\x00")
            flush()
        except BaseException as error:  # noqa: BLE001 — every pipe send failure closes the transport
            self.close()
            raise error

    def receive(self, deadline: float) -> bytes:
        try:
            message = self._messages.get(timeout=_remaining(deadline))
        except queue.Empty:
            raise socket.timeout("DevTools pipe timed out") from None
        if isinstance(message, BaseException):
            raise message
        if not isinstance(message, bytes):
            raise RuntimeError("browser DevTools pipe returned invalid data")
        return message

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for stream in (self._stdin, self._stdout):
            close = getattr(stream, "close", None)
            if callable(close):
                try:
                    close()
                except BaseException as close_error:
                    # close() of a dead Chromium pipe can raise OSError/BrokenPipe during teardown; nothing else can consume close_error.
                    pass

    def __enter__(self) -> _PipeConnection:
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> bool:
        self.close()
        return False


def _pipe_command(
    connection: _PipeConnection,
    command_id: int,
    method: str,
    timing: WaitTiming,
    params: dict[str, object] | None = None,
    session_id: str | None = None,
    on_event: Callable[[dict[str, object]], None] | None = None,
    complete: Callable[[], bool] | None = None,
    on_response: Callable[[dict[str, object]], None] | None = None,
    deadline: float | None = None,
) -> dict[str, object] | None:
    message: dict[str, object] = {"id": command_id, "method": method}
    if params is not None:
        message["params"] = params
    if session_id is not None:
        message["sessionId"] = session_id
    operation_deadline = deadline if deadline is not None else time.monotonic() + timing.total_s
    _remaining(operation_deadline)
    connection.send(json.dumps(message, separators=(",", ":")).encode("utf-8"))
    response: dict[str, object] | None = None
    response_notified = False
    while True:
        try:
            raw = connection.receive(operation_deadline)
            _remaining(operation_deadline)
        except socket.timeout as error:
            connection.close()
            raise error
        try:
            event = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            connection.close()
            raise RuntimeError("browser returned an invalid DevTools message") from error
        if not isinstance(event, dict):
            connection.close()
            raise RuntimeError("browser returned an invalid DevTools message")
        event_session = event.get("sessionId")
        belongs_to_session = session_id is None or event_session == session_id
        if belongs_to_session and event.get("id") == command_id:
            if "error" in event:
                raise RuntimeError("browser DevTools command failed")
            response = event
            if on_response is not None and not response_notified:
                response_notified = True
                on_response(response)
        elif belongs_to_session and on_event is not None:
            on_event(event)
        if response is not None and (complete is None or complete()):
            result = response.get("result")
            return result if isinstance(result, dict) else None


def _connect_pipe(process: subprocess.Popen[bytes], timing: WaitTiming) -> tuple[_PipeConnection, str]:
    connection = _PipeConnection(process)
    deadline = time.monotonic() + timing.total_s
    command_id = 1
    try:
        while True:
            targets = _pipe_command(connection, command_id, "Target.getTargets", timing, deadline=deadline)
            command_id += 1
            target_infos = targets.get("targetInfos") if isinstance(targets, dict) else None
            target_id = next(
                (
                    target.get("targetId")
                    for target in target_infos
                    if isinstance(target, dict) and target.get("type") == "page" and isinstance(target.get("targetId"), str) and target.get("targetId")
                ),
                None,
            ) if isinstance(target_infos, list) else None
            if isinstance(target_id, str):
                attached = _pipe_command(
                    connection,
                    command_id,
                    "Target.attachToTarget",
                    timing,
                    {"targetId": target_id, "flatten": True},
                    deadline=deadline,
                )
                session_id = attached.get("sessionId") if isinstance(attached, dict) else None
                if isinstance(session_id, str) and session_id:
                    return connection, session_id
                raise RuntimeError("browser returned no DevTools target session")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise socket.timeout("DevTools page target timed out")
            time.sleep(min(timing.poll_s, remaining))
    except BaseException:
        connection.close()
        raise


def _same_origin_path(raw: str, reference: str, path: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(raw)
        expected = urllib.parse.urlsplit(reference)
        query_matches = parsed.query == expected.query
        if path == "/" and expected.path == "/" and expected.query:
            query_matches = parsed.query in ("", expected.query)
        return same_origin(parsed, expected) and parsed.path == path and query_matches and not parsed.fragment
    except ValueError:
        return False


def _is_auth_request(raw: str, authenticate_url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(raw)
        expected = urllib.parse.urlsplit(authenticate_url)
        return same_origin(parsed, expected) and parsed.path == "/" and parsed.query == expected.query and not parsed.fragment
    except ValueError:
        return False


def _set_cookie_names(value: object, expected_name: str | None) -> set[str]:
    values = value if isinstance(value, list) else [value]
    names: set[str] = set()
    for item in values:
        if not isinstance(item, str):
            continue
        for line in item.splitlines():
            parts = [part.strip() for part in line.split(";")]
            if not parts or "=" not in parts[0]:
                continue
            name, cookie_value = parts[0].split("=", 1)
            name = name.strip()
            cookie_value = cookie_value.strip()
            if expected_name is None or name != expected_name or not _BASE64URL_COOKIE_NAME.fullmatch(name) or not cookie_value or cookie_value == '""':
                continue
            attributes: dict[str, str] = {}
            flags: set[str] = set()
            for attribute in parts[1:]:
                key, separator, attribute_value = attribute.partition("=")
                key = key.strip().lower()
                if not key:
                    continue
                if separator:
                    attributes[key] = attribute_value.strip()
                else:
                    flags.add(key)
            if "domain" in attributes or attributes.get("path") != "/" or "httponly" not in flags or attributes.get("samesite", "").lower() != "strict":
                continue
            names.add(name)
    return names


class _AuthenticationWait:
    def __init__(self, authenticate_url: str) -> None:
        self._authenticate_url = authenticate_url
        self._cookie_name = _official_cookie_name(authenticate_url)
        self._navigate_frame_id: str | None = None
        self._auth_request_frames: dict[str, str] = {}
        self._auth_request_ids: set[str] = set()
        self._successful_root_request_ids: set[str] = set()
        self._cookie_response_ids: set[str] = set()
        self._finished_request_ids: set[str] = set()
        self._load_event_seen = False
        self._cookie_names: set[str] = set()
        self._auth_request_observed = False
        self._auth_request_seen = False
        self._root_response_seen = False
        self._cookie_committed = False
        self._loaded = False

    def bind_navigate_response(self, response: dict[str, object]) -> None:
        result = response.get("result")
        frame_id = result.get("frameId") if isinstance(result, dict) else None
        if not isinstance(frame_id, str) or frame_id == "":
            raise RuntimeError("browser returned no Page.navigate frame")
        self._navigate_frame_id = frame_id
        self._refresh_frame_bound_state()

    def _refresh_frame_bound_state(self) -> None:
        frame_id = self._navigate_frame_id
        if frame_id is None:
            return
        self._auth_request_ids = {request_id for request_id, request_frame_id in self._auth_request_frames.items() if request_frame_id == frame_id}
        self._auth_request_seen = bool(self._auth_request_ids)
        self._root_response_seen = bool(self._successful_root_request_ids & self._auth_request_ids)
        self._cookie_committed = bool(self._cookie_response_ids & self._finished_request_ids & self._auth_request_ids)
        self._loaded = self._load_event_seen

    def _is_auth_origin_request(self, request_id: str) -> bool:
        return request_id in self._auth_request_ids

    def consume(self, event: dict[str, object]) -> None:
        method = event.get("method")
        params = event.get("params")
        if not isinstance(method, str) or not isinstance(params, dict):
            return
        if method == "Network.requestWillBeSent":
            request_id = params.get("requestId")
            request = params.get("request")
            frame_id = params.get("frameId")
            if isinstance(request_id, str) and isinstance(frame_id, str) and isinstance(request, dict) and isinstance(request.get("url"), str) and _is_auth_request(request["url"], self._authenticate_url):
                self._auth_request_observed = True
                self._auth_request_frames[request_id] = frame_id
                self._refresh_frame_bound_state()
            return
        if method == "Network.responseReceived":
            request_id = params.get("requestId")
            response = params.get("response")
            url = response.get("url") if isinstance(response, dict) else None
            status = response.get("status") if isinstance(response, dict) else None
            if isinstance(request_id, str) and isinstance(url, str) and isinstance(status, (int, float)) and 200 <= status < 400 and _same_origin_path(url, self._authenticate_url, "/"):
                self._successful_root_request_ids.add(request_id)
            if isinstance(request_id, str) and isinstance(response, dict):
                headers = response.get("headers")
                header_value = next((value for key, value in headers.items() if isinstance(key, str) and key.lower() == "set-cookie"), None) if isinstance(headers, dict) else None
                names = _set_cookie_names(header_value, self._cookie_name)
                if names:
                    self._cookie_names.update(names)
                    self._cookie_response_ids.add(request_id)
            self._refresh_frame_bound_state()
            return
        if method == "Network.responseReceivedExtraInfo":
            request_id = params.get("requestId")
            headers = params.get("headers")
            if not isinstance(request_id, str) or not isinstance(headers, dict):
                return
            header_value = next((value for key, value in headers.items() if isinstance(key, str) and key.lower() == "set-cookie"), None)
            names = _set_cookie_names(header_value, self._cookie_name)
            if names:
                self._cookie_names.update(names)
                self._cookie_response_ids.add(request_id)
            self._refresh_frame_bound_state()
            return
        if method == "Network.loadingFinished":
            request_id = params.get("requestId")
            if not isinstance(request_id, str):
                return
            self._finished_request_ids.add(request_id)
            self._refresh_frame_bound_state()
            return
        if method == "Page.loadEventFired" and self._auth_request_observed:
            self._load_event_seen = True
            self._refresh_frame_bound_state()

    def complete(self) -> bool:
        return self._auth_request_seen and self._root_response_seen and self._cookie_committed and self._loaded

    @property
    def cookie_names(self) -> frozenset[str]:
        return frozenset(self._cookie_names)


def _canonical_host(value: str) -> str:
    try:
        return value.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return value.lower()


def _canonical_authority(raw_url: str) -> str | None:
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        hostname = parsed.hostname
        if hostname is None:
            return None
        if ":" in hostname:
            host = "[" + ipaddress.IPv6Address(hostname).compressed.lower() + "]"
        else:
            host = _canonical_host(hostname)
        port = parsed.port
        if port is None or (parsed.scheme.lower() == "http" and port == 80) or (parsed.scheme.lower() == "https" and port == 443):
            return host
        return f"{host}:{port}"
    except ValueError:
        return None


def _official_cookie_name(authenticate_url: str) -> str | None:
    authority = _canonical_authority(authenticate_url)
    if authority is None:
        return None
    suffix = base64.urlsafe_b64encode(hashlib.sha256(authority.encode("utf-8")).digest()).decode("ascii").rstrip("=")
    return "dsh-auth-" + suffix


def _cookie_committed_for_origin(result: dict[str, object] | None, authenticate_url: str, names: frozenset[str]) -> bool:
    if not names or result is None or not isinstance(result.get("cookies"), list):
        return False
    parsed = urllib.parse.urlsplit(authenticate_url)
    if parsed.hostname is None:
        return False
    host = _canonical_host(parsed.hostname)
    expected_name = _official_cookie_name(authenticate_url)
    if expected_name is None:
        return False
    for cookie in result["cookies"]:
        if not isinstance(cookie, dict):
            continue
        cookie_name = cookie.get("name")
        cookie_value = cookie.get("value")
        if (
            not isinstance(cookie_name, str)
            or cookie_name != expected_name
            or cookie_name not in names
            or not isinstance(cookie_value, str)
            or not cookie_value.strip()
            or cookie_value == '""'
            or cookie.get("httpOnly") is not True
            or cookie.get("sameSite") != "Strict"
            or cookie.get("path") != "/"
            or cookie.get("hostOnly") is False
        ):
            continue
        domain = cookie.get("domain")
        if not isinstance(domain, str) or domain.startswith(".") or _canonical_host(domain) != host:
            continue
        return True
    return False


class _BuddyNavigationWait:
    def __init__(self, buddy_url: str) -> None:
        self._buddy_url = buddy_url
        self._target_request_ids: set[str] = set()
        self._request_frame_ids: dict[str, str] = {}
        self._successful_frame_ids: set[str] = set()
        self._successful_request_ids: set[str] = set()
        self._target_frame_id: str | None = None
        self._target_seen = False
        self._successful_response = False
        self._loaded = False

    def _refresh_success(self) -> None:
        if self._target_frame_id is not None:
            self._successful_response = self._target_frame_id in self._successful_frame_ids
        else:
            self._successful_response = bool(self._successful_request_ids)

    def consume(self, event: dict[str, object]) -> None:
        method = event.get("method")
        params = event.get("params")
        if not isinstance(params, dict):
            return
        if method == "Network.requestWillBeSent":
            request_id = params.get("requestId")
            request = params.get("request")
            url = request.get("url") if isinstance(request, dict) else None
            frame_id = params.get("frameId")
            if isinstance(request_id, str) and isinstance(url, str) and _same_origin_path(url, self._buddy_url, "/buddy"):
                self._target_request_ids.add(request_id)
                if isinstance(frame_id, str):
                    self._request_frame_ids[request_id] = frame_id
            return
        if method == "Network.responseReceived":
            request_id = params.get("requestId")
            response = params.get("response")
            url = response.get("url") if isinstance(response, dict) else None
            status = response.get("status") if isinstance(response, dict) else None
            resource_type = response.get("type") if isinstance(response, dict) else None
            if (isinstance(request_id, str) and request_id in self._target_request_ids and isinstance(url, str) and _same_origin_path(url, self._buddy_url, "/buddy") and isinstance(status, (int, float)) and 200 <= status < 300 and (resource_type is None or resource_type == "Document")):
                frame_id = response.get("frameId") if isinstance(response, dict) else None
                frame_id = frame_id if isinstance(frame_id, str) else self._request_frame_ids.get(request_id)
                if isinstance(frame_id, str):
                    self._successful_frame_ids.add(frame_id)
                else:
                    self._successful_request_ids.add(request_id)
                self._refresh_success()
            return
        if method == "Page.frameNavigated":
            frame = params.get("frame")
            url = frame.get("url") if isinstance(frame, dict) else None
            parent_id = frame.get("parentId") if isinstance(frame, dict) else None
            if isinstance(url, str) and parent_id is None and _same_origin_path(url, self._buddy_url, "/buddy"):
                frame_id = frame.get("id") if isinstance(frame, dict) else None
                self._target_frame_id = frame_id if isinstance(frame_id, str) else None
                self._target_seen = True
                self._refresh_success()
            return
        if method == "Page.loadEventFired" and self._target_seen:
            self._loaded = True

    def complete(self) -> bool:
        return self._target_seen and self._successful_response and self._loaded


def _validate_extra_args(extra_args: list[str]) -> None:
    for argument in extra_args:
        if not isinstance(argument, str):
            raise ValueError("browser arguments must be strings")
        if not argument.startswith("--"):
            raise ValueError("browser arguments must be Chromium flags")
        if argument not in _ALLOWED_EXTRA_ARGUMENTS:
            raise ValueError("browser argument is not allowlisted")


def _prepare_devtools_pipe() -> None:
    os.dup2(0, 3)
    os.dup2(1, 4)


def _browser_command(browser: str, urls: LaunchUrls, profile: str, _port: int | None, extra_args: list[str]) -> list[str]:
    """Build a Chromium command that starts blank and exposes only the private pipe."""

    _validate_extra_args(extra_args)
    command = [
        browser,
        f"--user-data-dir={profile}",
        "--disable-features=Translate",
        "--disable-extensions",
        "--no-first-run",
        "--remote-debugging-pipe",
        f"--app={_INITIAL_PAGE}",
        f"--window-size={TARGET_W},{TARGET_H}",
        "--window-position=1920,0",
        "--ozone-platform=x11",
        *extra_args,
    ]
    token = urllib.parse.urlsplit(urls.authenticate_url).query.removeprefix("token=")
    if any(token and token in argument or urls.authenticate_url in argument for argument in command):
        raise ValueError("browser arguments must not contain the authentication token")
    return command


_BROWSER_RUNTIME_ENVIRONMENT = frozenset(
    {
        "PATH",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE",
        "DBUS_SESSION_BUS_ADDRESS",
        "LANG",
        "LANGUAGE",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "CHROME_DEVEL_SANDBOX",
        "NO_AT_BRIDGE",
        "GDK_BACKEND",
        "QT_QPA_PLATFORM",
        "XMODIFIERS",
        "GTK_IM_MODULE",
        "QT_IM_MODULE",
        "LIBGL_ALWAYS_SOFTWARE",
        "LIBGL_DRIVERS_PATH",
        "LIBVA_DRIVER_NAME",
        "LIBVA_DRIVERS_PATH",
        "MESA_LOADER_DRIVER_OVERRIDE",
        "LC_ALL",
        "LC_COLLATE",
        "LC_CTYPE",
        "LC_MESSAGES",
        "LC_MONETARY",
        "LC_NUMERIC",
        "LC_TIME",
        "LC_PAPER",
        "LC_NAME",
        "LC_ADDRESS",
        "LC_TELEPHONE",
        "LC_MEASUREMENT",
        "LC_IDENTIFICATION",
    }
)


def _browser_environment(urls: LaunchUrls, profile: str | None = None) -> dict[str, str]:
    """Build a display-only Chromium environment without ambient credentials."""

    token = urllib.parse.urlsplit(urls.authenticate_url).query.removeprefix("token=")
    environment: dict[str, str] = {}
    for key, value in os.environ.items():
        if key not in _BROWSER_RUNTIME_ENVIRONMENT:
            continue
        if token and (token in key or token in value):
            continue
        if urls.authenticate_url in value:
            continue
        environment[key] = value
    if profile is not None:
        if token and token in profile:
            raise ValueError("browser profile path must not contain the authentication token")
        environment["HOME"] = profile
        environment["USERPROFILE"] = profile
        environment["XDG_CONFIG_HOME"] = os.path.join(profile, "config")
        environment["XDG_CACHE_HOME"] = os.path.join(profile, "cache")
    return environment


def _ensure_private_parent(parent: str) -> None:
    """Create each profile parent component only after an lstat check."""

    parent = os.path.abspath(parent)
    drive, tail = os.path.splitdrive(parent)
    current = drive + os.path.sep if drive else os.path.abspath(os.path.sep)
    relative = tail.lstrip("/\\")
    for component in relative.split(os.path.sep):
        if not component:
            continue
        current = os.path.join(current, component)
        try:
            metadata = os.lstat(current)
        except FileNotFoundError:
            try:
                os.mkdir(current, mode=0o700)
            except FileExistsError:
                metadata = os.lstat(current)
            else:
                metadata = os.lstat(current)
        if stat.S_ISLNK(metadata.st_mode) or os.path.normcase(os.path.realpath(current)) != os.path.normcase(current):
            raise ValueError("DSH_BUDDY_KIOSK_DATA parent must not contain symlinks")
        if not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("DSH_BUDDY_KIOSK_DATA parent must be a directory")


def _ensure_private_profile(profile: str) -> None:
    """Create or validate the private directory used for Chromium cookies."""

    profile = os.path.abspath(profile)
    if profile == os.path.abspath(os.sep):
        raise ValueError("DSH_BUDDY_KIOSK_DATA must not be the filesystem root")
    parent = os.path.dirname(profile)
    try:
        _ensure_private_parent(parent)
        if os.path.lexists(profile):
            metadata = os.lstat(profile)
            if stat.S_ISLNK(metadata.st_mode):
                raise ValueError("DSH_BUDDY_KIOSK_DATA must not be a symlink")
            if not stat.S_ISDIR(metadata.st_mode):
                raise ValueError("DSH_BUDDY_KIOSK_DATA must be a directory")
        else:
            os.mkdir(profile, mode=0o700)
        metadata = os.lstat(profile)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("DSH_BUDDY_KIOSK_DATA must be a non-symlink directory")
        owner = os.geteuid() if hasattr(os, "geteuid") else metadata.st_uid
        if metadata.st_uid != owner:
            raise ValueError("DSH_BUDDY_KIOSK_DATA must be owned by the launching user")
        if stat.S_IMODE(metadata.st_mode) != 0o700:
            os.chmod(profile, 0o700)
        metadata = os.lstat(profile)
    except ValueError:
        raise
    except OSError as error:
        raise RuntimeError("DSH_BUDDY_KIOSK_DATA could not be prepared") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise RuntimeError("DSH_BUDDY_KIOSK_DATA is not a private directory")
    owner = os.geteuid() if hasattr(os, "geteuid") else metadata.st_uid
    if metadata.st_uid != owner:
        raise RuntimeError("DSH_BUDDY_KIOSK_DATA ownership changed")
    if os.path.realpath(profile) != profile:
        raise RuntimeError("DSH_BUDDY_KIOSK_DATA must not resolve through a symlink")


def _capture_process_group(process: subprocess.Popen[bytes]) -> int | None:
    if os.name != "posix":
        return None
    pid = getattr(process, "pid", None)
    if not isinstance(pid, int) or pid <= 0 or process.poll() is not None:
        return None
    try:
        pgid = os.getpgid(pid)
    except OSError:
        return None
    return pgid if pgid == pid else None


def _signal_process_tree(
    process: subprocess.Popen[bytes],
    signal_number: int,
    fallback: Callable[[], None],
    process_group: int | None = None,
) -> bool:
    pid = getattr(process, "pid", None)
    if process.poll() is not None:
        return False
    if not isinstance(pid, int) or pid <= 0:
        fallback()
        return True
    if os.name == "posix" and process_group is not None:
        try:
            if os.getpgid(pid) == process_group == pid:
                os.killpg(process_group, signal_number)
                return True
        except ProcessLookupError:
            return False
        except OSError:
            pass
        if process.poll() is None:
            fallback()
            return True
        return False
    fallback()
    return True


def _cleanup_process(
    process: subprocess.Popen[bytes],
    wait_timeout: float,
    process_group: int | None = None,
) -> None:
    if process.poll() is not None:
        return
    if process_group is None:
        process_group = _capture_process_group(process)
    failures: list[BaseException] = []
    force_kill = False
    try:
        _signal_process_tree(process, signal.SIGTERM, process.terminate, process_group)
    except BaseException as error:  # noqa: BLE001 — preserve every cleanup failure
        failures.append(error)
        force_kill = True
    try:
        process.wait(timeout=wait_timeout)
    except subprocess.TimeoutExpired:
        force_kill = True
    except BaseException as error:  # noqa: BLE001 — force-kill and reap after every failed wait
        failures.append(error)
        force_kill = True
    if force_kill:
        try:
            _signal_process_tree(process, signal.SIGKILL, process.kill, process_group)
        except BaseException as error:  # noqa: BLE001 — still attempt the reap
            failures.append(error)
        try:
            process.wait(timeout=wait_timeout)
        except BaseException as error:  # noqa: BLE001 — preserve failed reap
            failures.append(error)
    if failures:
        if len(failures) == 1:
            raise failures[0]
        raise ExceptionGroup("browser cleanup failed", failures)


def _launch(urls: LaunchUrls, extra_args: list[str], timing: WaitTiming) -> int:
    profile = _profile_path()
    _ensure_private_profile(profile)
    command = _browser_command(_browser_path(), urls, profile, 0, extra_args)
    browser_env = _browser_environment(urls, profile)
    process: subprocess.Popen[bytes] | None = None
    process_group: int | None = None
    exit_code: int | None = None
    operation_error: BaseException | None = None
    try:
        popen_options: dict[str, object] = {"env": browser_env, "stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "bufsize": 0}
        if os.name == "posix":
            popen_options["start_new_session"] = True
            popen_options["preexec_fn"] = _prepare_devtools_pipe
            popen_options["pass_fds"] = (3, 4)
        process = subprocess.Popen(command, **popen_options)
        process_group = _capture_process_group(process)
        connection, session_id = _connect_pipe(process, timing)
        with connection:
            _pipe_command(connection, 3, "Page.enable", timing, session_id=session_id)
            _pipe_command(connection, 4, "Network.enable", timing, session_id=session_id)
            authentication = _AuthenticationWait(urls.authenticate_url)
            _pipe_command(
                connection,
                5,
                "Page.navigate",
                timing,
                {"url": urls.authenticate_url},
                session_id=session_id,
                on_event=authentication.consume,
                complete=authentication.complete,
                on_response=authentication.bind_navigate_response,
            )
            cookies = _pipe_command(connection, 6, "Network.getAllCookies", timing, session_id=session_id)
            if not _cookie_committed_for_origin(cookies, urls.authenticate_url, authentication.cookie_names):
                raise RuntimeError("browser authentication cookie was not committed")
            buddy = _BuddyNavigationWait(urls.buddy_url)
            _pipe_command(
                connection,
                7,
                "Page.navigate",
                timing,
                {"url": urls.buddy_url},
                session_id=session_id,
                on_event=buddy.consume,
                complete=buddy.complete,
            )
        exit_code = process.wait()
    except KeyboardInterrupt:
        exit_code = 130
    except BaseException as error:  # noqa: BLE001 — combine operation and cleanup failures
        operation_error = error

    cleanup_error: BaseException | None = None
    if process is not None:
        try:
            _cleanup_process(process, timing.request_s, process_group)
        except BaseException as error:  # noqa: BLE001 — report cleanup failure to caller
            cleanup_error = error
    if operation_error is not None:
        if cleanup_error is not None:
            raise BaseExceptionGroup("browser launch and cleanup failed", [operation_error, cleanup_error]) from operation_error
        raise operation_error
    if cleanup_error is not None:
        raise cleanup_error
    return 130 if exit_code is None else exit_code


def _browser_path() -> str:
    configured = os.environ.get("DSH_BUDDY_CHROME", "")
    if configured:
        return configured
    for candidate in ("google-chrome", "chromium-browser", "chromium"):
        resolved = shutil.which(candidate)
        if resolved is not None:
            return resolved
    raise RuntimeError("Chrome or Chromium is required")


def _profile_path() -> str:
    raw = os.environ.get("DSH_BUDDY_KIOSK_DATA")
    if raw is not None:
        if raw == "":
            raise ValueError("DSH_BUDDY_KIOSK_DATA must not be empty")
        if not os.path.isabs(raw):
            raise ValueError("DSH_BUDDY_KIOSK_DATA must be an absolute path")
        return os.path.abspath(raw)
    raw = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "dsh-buddy-kiosk")
    return os.path.abspath(os.path.expanduser(raw))


def main(argv: list[str]) -> int:
    try:
        urls = validate_launch_urls()
        timing = load_wait_timing()
        return _launch(urls, argv, timing)
    except ValueError as error:
        print(f"kiosk configuration error: {error}", file=sys.stderr)
        return 2
    except (OSError, RuntimeError, urllib.error.URLError, ExceptionGroup):
        print("kiosk browser authentication failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
