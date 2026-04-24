"""Persistence + in-memory ring buffer.

- SQLite (WAL mode) with two tables: `packets` (one row per decoded frame)
  and `metrics` (one row per 1 Hz tick snapshot).
- `deque(maxlen=50000)` ring buffer for recent frames, so the UI can request
  a backfill without hitting disk on every connect.

The store writes on a background thread so the capture path never blocks on
disk I/O; the ring buffer is updated synchronously on the capture thread.
"""

from __future__ import annotations

import json
import queue
import sqlite3
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .frame import Frame


_SCHEMA = """
CREATE TABLE IF NOT EXISTS packets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           REAL NOT NULL,
    transport    TEXT,
    protocol     TEXT,
    pkt_type     TEXT,
    correlation  INTEGER,
    topic        TEXT,
    qos          INTEGER,
    payload_len  INTEGER,
    src_ip       TEXT, src_port INTEGER,
    dst_ip       TEXT, dst_port INTEGER,
    latency_ms   REAL,
    is_error     INTEGER,
    raw          BLOB,
    summary      TEXT
);
CREATE INDEX IF NOT EXISTS idx_packets_ts ON packets(ts);
CREATE INDEX IF NOT EXISTS idx_packets_proto ON packets(protocol);

CREATE TABLE IF NOT EXISTS metrics (
    ts           REAL PRIMARY KEY,
    throughput_bps REAL,
    throughput_mps REAL,
    p50_ms       REAL,
    p95_ms       REAL,
    p99_ms       REAL,
    error_rate   REAL,
    reconnect_count INTEGER,
    jitter_ms    REAL,
    extra        TEXT
);
"""


@dataclass
class Store:
    db_path: str = "sniffer.db"
    ring_size: int = 50_000
    ring: deque[Frame] = field(default_factory=lambda: deque(maxlen=50_000))
    _q: queue.Queue = field(default_factory=queue.Queue)
    _stop: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None

    def __post_init__(self) -> None:
        if self.ring.maxlen != self.ring_size:
            self.ring = deque(maxlen=self.ring_size)

    def start(self) -> None:
        self._thread = threading.Thread(target=self._writer_loop, daemon=True, name="store-writer")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._q.put(None)
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    # --- hot path (capture thread) ---
    def record_frame(self, f: Frame) -> None:
        self.ring.append(f)
        self._q.put(("frame", f))

    def record_metrics(self, snapshot: dict[str, Any]) -> None:
        self._q.put(("metrics", snapshot))

    def recent(self, n: int = 200) -> list[Frame]:
        return list(self.ring)[-n:]

    # --- writer thread ---
    def _writer_loop(self) -> None:
        conn = sqlite3.connect(self.db_path, check_same_thread=False, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.executescript(_SCHEMA)
        while not self._stop.is_set():
            try:
                item = self._q.get(timeout=0.5)
            except queue.Empty:
                continue
            if item is None:
                break
            kind, payload = item
            try:
                if kind == "frame":
                    self._write_frame(conn, payload)
                elif kind == "metrics":
                    self._write_metrics(conn, payload)
            except sqlite3.Error:
                # Don't let a bad row kill the writer.
                pass
        conn.close()

    def _write_frame(self, conn: sqlite3.Connection, f: Frame) -> None:
        conn.execute(
            "INSERT INTO packets (ts, transport, protocol, pkt_type, correlation, topic, qos, "
            "payload_len, src_ip, src_port, dst_ip, dst_port, latency_ms, is_error, raw, summary) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                f.timestamp, f.transport, f.protocol, f.pkt_type, f.correlation_id,
                f.topic, f.qos, f.payload_len, f.src_ip, f.src_port, f.dst_ip, f.dst_port,
                f.latency_ms, 1 if f.is_error else 0, bytes(f.raw_bytes), f.summary,
            ),
        )

    def _write_metrics(self, conn: sqlite3.Connection, s: dict[str, Any]) -> None:
        conn.execute(
            "INSERT OR REPLACE INTO metrics (ts, throughput_bps, throughput_mps, "
            "p50_ms, p95_ms, p99_ms, error_rate, reconnect_count, jitter_ms, extra) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                s.get("ts", time.time()),
                s.get("throughput_bps", 0.0),
                s.get("throughput_mps", 0.0),
                s.get("p50_ms", 0.0),
                s.get("p95_ms", 0.0),
                s.get("p99_ms", 0.0),
                s.get("error_rate", 0.0),
                int(s.get("reconnect_count", 0)),
                s.get("jitter_ms", 0.0),
                json.dumps({k: v for k, v in s.items() if k not in {
                    "ts", "throughput_bps", "throughput_mps",
                    "p50_ms", "p95_ms", "p99_ms",
                    "error_rate", "reconnect_count", "jitter_ms",
                }}),
            ),
        )
