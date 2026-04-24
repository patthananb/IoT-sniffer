"""WebSocket push server + CLI entry point.

Runs the capture engine on scapy's thread, a metrics tick every 1 s, and
broadcasts two message types to all connected frontend clients on port
8765:

    { "type": "frame",   "data": <frame dict> }
    { "type": "metrics", "data": <metrics snapshot> }

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
import signal
import time
from typing import Any

import websockets

from .capture import CaptureConfig, CaptureEngine
from .frame import Frame
from .store import Store


log = logging.getLogger("sniffer.server")


class PushServer:
    def __init__(self, engine: CaptureEngine, store: Store, host: str = "0.0.0.0", port: int = 8765) -> None:
        self.engine = engine
        self.store = store
        self.host = host
        self.port = port
        self.clients: set[websockets.WebSocketServerProtocol] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop = asyncio.Event()

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
        for ws in self.clients:
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

    async def _handler(self, ws) -> None:
        self.clients.add(ws)
        try:
            # Backfill the last ~200 frames so a fresh tab isn't empty.
            for f in self.store.recent(200):
                await ws.send(json.dumps({"type": "frame", "data": f.to_dict()}, default=_json_default))
            await ws.send(json.dumps({"type": "metrics", "data": self.engine.metrics_snapshot()}, default=_json_default))
            async for _ in ws:
                pass  # we don't accept commands yet
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)

    async def serve(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.engine.publish = self._publish_frame  # type: ignore[method-assign]
        self.engine.start()
        self.store.start()
        log.info("WebSocket push server listening on ws://%s:%s", self.host, self.port)
        async with websockets.serve(self._handler, self.host, self.port):
            ticker = asyncio.create_task(self._metrics_ticker())
            try:
                await self._stop.wait()
            finally:
                ticker.cancel()
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
    p.add_argument("--ws-host", default="0.0.0.0", help="push server bind host")
    p.add_argument("--ws-port", type=int, default=8765)
    p.add_argument("--db", default="sniffer.db", help="SQLite database path")
    p.add_argument("--log-level", default="INFO")
    args = p.parse_args(argv)

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
    server = PushServer(engine, store, host=args.ws_host, port=args.ws_port)

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
