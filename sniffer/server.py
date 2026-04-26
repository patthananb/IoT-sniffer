"""WebSocket push server + CLI entry point.

Runs the capture engine on scapy's thread, a metrics tick every 1 s, a
performance snapshot every 5 s, and broadcasts these message types to all
connected frontend clients on port 8765:

    { "type": "frame",   "data": <frame dict> }
    { "type": "metrics", "data": <metrics snapshot> }       # 1 Hz
    { "type": "perf",    "data": <perf snapshot> }          # 0.2 Hz
    { "type": "query_reply", "request_id": <id>, "kind": ..., "data": ... }

Clients can send `{"type": "query", "request_id": <id>, "query": <kind>}`
to request CSV exports or historical metrics; the server replies on the
same socket. Recognised query kinds:

    - "csv_samples"  : per-sample latency CSV (rolling window)
    - "csv_per_flow" : per-flow summary CSV
    - "csv_history"  : full metrics-table history CSV (from SQLite)
    - "history"      : last N metrics rows as JSON (param: limit, default 600)

Usage:
    python -m sniffer.server --iface eth0 --modbus-port 502 \\
        --mqtt-port 1883 --mqttws-port 8083

The frontend in `frontend/` connects to `ws://localhost:8765` and renders.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import secrets
import signal
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

import websockets

from .capture import CaptureConfig, CaptureEngine
from .frame import Frame
from .store import Store


log = logging.getLogger("sniffer.server")


class PushServer:
    def __init__(
        self,
        engine: CaptureEngine,
        store: Store,
        host: str = "127.0.0.1",
        port: int = 8765,
        auth_token: str = "",
        origins: list[str] | None = None,
    ) -> None:
        self.engine = engine
        self.store = store
        self.host = host
        self.port = port
        # Empty token disables auth (matches pre-1.5 behaviour).
        self.auth_token = auth_token or ""
        # None  → accept any Origin (legacy); pass-through to websockets.serve.
        # []    → reject browser clients (only non-Origin clients allowed).
        # list  → allowlist of exact Origin strings.
        self.origins = origins
        self.clients: set[websockets.WebSocketServerProtocol] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop = asyncio.Event()

    def _check_auth(self, ws) -> bool:
        if not self.auth_token:
            return True
        request = getattr(ws, "request", None)
        if request is None:
            return False
        headers = getattr(request, "headers", None)
        auth_hdr = ""
        if headers is not None:
            try:
                auth_hdr = headers.get("Authorization", "") or ""
            except Exception:
                auth_hdr = ""
        if auth_hdr.startswith("Bearer "):
            if secrets.compare_digest(auth_hdr[7:], self.auth_token):
                return True
        path = getattr(request, "path", "") or ""
        try:
            qs_token = parse_qs(urlparse(path).query).get("token", [""])[0]
        except Exception:
            qs_token = ""
        if qs_token and secrets.compare_digest(qs_token, self.auth_token):
            return True
        return False

    # --- scapy-thread → asyncio-loop bridge ---
    def _publish_frame(self, f: Frame) -> None:
        self.store.record_frame(f)
        if self._loop is None:
            return
        msg = json.dumps({"type": "frame", "data": f.to_dict()}, default=_json_default)
        asyncio.run_coroutine_threadsafe(self._broadcast(msg), self._loop)

    async def _broadcast(self, msg: str) -> None:
        if not self.clients:
            return
        dead: list = []
        # Snapshot: a client may connect/disconnect while `await ws.send` yields,
        # which would otherwise raise "Set changed size during iteration".
        for ws in list(self.clients):
            try:
                await ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def _metrics_ticker(self) -> None:
        while not self._stop.is_set():
            try:
                snap = self.engine.metrics_snapshot()
                self.engine.latency.expire()
                self.store.record_metrics(snap)
                msg = json.dumps({"type": "metrics", "data": snap}, default=_json_default)
                await self._broadcast(msg)
            except Exception as e:  # never let the tick die silently
                log.exception("metrics tick failed: %s", e)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass

    async def _perf_ticker(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
            if self._stop.is_set():
                return
            try:
                snap = self.engine.perf_snapshot()
                msg = json.dumps({"type": "perf", "data": snap}, default=_json_default)
                await self._broadcast(msg)
            except Exception as e:
                log.exception("perf tick failed: %s", e)

    async def _handler(self, ws) -> None:
        if not self._check_auth(ws):
            log.warning("rejecting unauthenticated WS connection from %s",
                        getattr(ws, "remote_address", "?"))
            try:
                await ws.close(code=1008, reason="unauthorized")
            except Exception:
                pass
            return
        self.clients.add(ws)
        try:
            # Backfill the last ~200 frames so a fresh tab isn't empty.
            for f in self.store.recent(200):
                await ws.send(json.dumps({"type": "frame", "data": f.to_dict()}, default=_json_default))
            await ws.send(json.dumps({"type": "metrics", "data": self.engine.metrics_snapshot()}, default=_json_default))
            await ws.send(json.dumps({"type": "perf", "data": self.engine.perf_snapshot()}, default=_json_default))
            async for raw in ws:
                await self._handle_client_message(ws, raw)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)

    async def _handle_client_message(self, ws, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except (TypeError, ValueError):
            return
        if not isinstance(msg, dict) or msg.get("type") != "query":
            return
        kind = msg.get("query")
        rid = msg.get("request_id")
        try:
            if kind == "csv_samples":
                payload = {"kind": "csv_samples", "filename": "latency_samples.csv",
                           "data": self.engine.perf.export_samples_csv()}
            elif kind == "csv_per_flow":
                payload = {"kind": "csv_per_flow", "filename": "per_flow_stats.csv",
                           "data": self.engine.perf.export_per_flow_csv()}
            elif kind == "csv_history":
                payload = {"kind": "csv_history", "filename": "metrics_history.csv",
                           "data": self.store.export_metrics_csv()}
            elif kind == "history":
                limit = int(msg.get("limit", 600))
                payload = {"kind": "history",
                           "data": self.store.metrics_history(limit=limit)}
            else:
                payload = {"kind": kind, "error": "unknown query"}
        except Exception as e:
            log.exception("query %r failed", kind)
            payload = {"kind": kind, "error": str(e)}
        payload["request_id"] = rid
        try:
            await ws.send(json.dumps({"type": "query_reply", **payload}, default=_json_default))
        except websockets.exceptions.ConnectionClosed:
            pass

    async def serve(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.engine.publish = self._publish_frame  # type: ignore[method-assign]
        self.engine.start()
        self.store.start()
        log.info("WebSocket push server listening on ws://%s:%s", self.host, self.port)
        if self.auth_token:
            log.info("auth: bearer token required (header or ?token=)")
        else:
            log.warning("auth: DISABLED — set --auth-token / SNIFFER_AUTH_TOKEN to enable")
        if self.origins is None:
            log.warning("origins: any (browser CSWSH possible) — set --origins to restrict")
        else:
            log.info("origins allowlist: %s", self.origins or "(non-browser only)")
        serve_kwargs: dict[str, Any] = {}
        if self.origins is not None:
            serve_kwargs["origins"] = self.origins
        async with websockets.serve(self._handler, self.host, self.port, **serve_kwargs):
            ticker = asyncio.create_task(self._metrics_ticker())
            perf_ticker = asyncio.create_task(self._perf_ticker())
            try:
                await self._stop.wait()
            finally:
                ticker.cancel()
                perf_ticker.cancel()
                self.engine.stop()
                self.store.stop()

    def request_stop(self) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._stop.set)


def _json_default(o: Any) -> Any:
    if isinstance(o, bytes):
        return list(o)
    raise TypeError(f"not JSON-serializable: {type(o).__name__}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="sniffer", description="IoT protocol sniffer (Modbus/TCP, MQTT/TCP, MQTT/WS)")
    p.add_argument("--iface", required=True, help="capture interface (e.g. eth0, en0, any)")
    p.add_argument("--modbus-port", type=int, default=502)
    p.add_argument("--mqtt-port", type=int, default=1883)
    p.add_argument("--mqttws-port", type=int, default=8083)
    p.add_argument(
        "--ws-host",
        default=os.environ.get("SNIFFER_WS_HOST", "127.0.0.1"),
        help="push server bind host (default 127.0.0.1; use 0.0.0.0 to expose, "
             "but combine with --auth-token + --origins)",
    )
    p.add_argument("--ws-port", type=int, default=8765)
    p.add_argument("--db", default="sniffer.db", help="SQLite database path")
    p.add_argument("--log-level", default="INFO")
    p.add_argument(
        "--auth-token",
        default=os.environ.get("SNIFFER_AUTH_TOKEN", ""),
        help="bearer token required for WS connections (default $SNIFFER_AUTH_TOKEN; "
             "empty disables auth)",
    )
    p.add_argument(
        "--origins",
        default=os.environ.get("SNIFFER_ORIGINS"),
        help="comma-separated allowlist of Origin headers (default $SNIFFER_ORIGINS; "
             "unset accepts any; empty string rejects browsers)",
    )
    args = p.parse_args(argv)

    # Unset or empty → no Origin check. Otherwise comma-separated allowlist.
    origins: list[str] | None
    if args.origins is None or not args.origins.strip():
        origins = None
    else:
        origins = [o.strip() for o in args.origins.split(",") if o.strip()]

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    cfg = CaptureConfig(
        iface=args.iface,
        modbus_port=args.modbus_port,
        mqtt_port=args.mqtt_port,
        mqttws_port=args.mqttws_port,
    )
    # publish is wired up inside PushServer.serve() once the loop is alive.
    engine = CaptureEngine(cfg=cfg, publish=lambda _f: None)
    store = Store(db_path=args.db)
    server = PushServer(
        engine, store,
        host=args.ws_host, port=args.ws_port,
        auth_token=args.auth_token, origins=origins,
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _sigint(*_):
        server.request_stop()

    signal.signal(signal.SIGINT, _sigint)
    signal.signal(signal.SIGTERM, _sigint)

    try:
        loop.run_until_complete(server.serve())
    finally:
        loop.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
