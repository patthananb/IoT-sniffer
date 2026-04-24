"""Derived signals: jitter, retransmits, error rate, reconnect rate.

- **Jitter per MQTT topic** — RFC 3550 smoothed mean absolute deviation:
      J_i = J_{i-1} + (|D(i-1,i)| - J_{i-1}) / 16
  where D is the inter-arrival interval. Seeded from the first interval.

- **TCP retransmits** — detected in `transport.tcp.TCPStream` when a segment's
  sequence number regresses vs. the last one we saw on that direction. This
  module just aggregates totals across flows.

- **Modbus error rate** — exceptions / total Modbus frames, windowed.

- **MQTT reconnect rate** — increments each time we see a CONNECT on a flow
  that previously had one (broker dropped or client looped).
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Hashable


@dataclass
class _TopicJitter:
    last_ts: float | None = None
    last_interval: float | None = None
    jitter_s: float = 0.0  # smoothed MAD

    def tick(self, ts: float) -> float:
        if self.last_ts is None:
            self.last_ts = ts
            return 0.0
        interval = ts - self.last_ts
        self.last_ts = ts
        if self.last_interval is None:
            self.last_interval = interval
            return 0.0
        d = abs(interval - self.last_interval)
        self.jitter_s += (d - self.jitter_s) / 16.0
        self.last_interval = interval
        return self.jitter_s


@dataclass
class DerivedMetrics:
    window_s: float = 60.0
    _jitters: dict[str, _TopicJitter] = field(default_factory=dict)
    _retransmits_total: int = 0
    _modbus_total_events: deque[tuple[float, bool]] = field(default_factory=deque)  # (ts, is_exc)
    _mqtt_connect_seen: set[Hashable] = field(default_factory=set)
    reconnect_count: int = 0

    # ----- jitter -----
    def mqtt_publish(self, topic: str, ts: float | None = None) -> float:
        ts = ts if ts is not None else time.time()
        j = self._jitters.get(topic)
        if j is None:
            j = _TopicJitter()
            self._jitters[topic] = j
        return j.tick(ts) * 1000.0  # ms

    def jitter_ms(self, topic: str | None = None) -> float:
        if topic is not None:
            j = self._jitters.get(topic)
            return j.jitter_s * 1000.0 if j else 0.0
        if not self._jitters:
            return 0.0
        return sum(j.jitter_s for j in self._jitters.values()) / len(self._jitters) * 1000.0

    # ----- retransmits -----
    def add_retransmits(self, delta: int) -> None:
        self._retransmits_total += delta

    @property
    def retransmits(self) -> int:
        return self._retransmits_total

    # ----- modbus error rate -----
    def modbus_seen(self, is_exception: bool, ts: float | None = None) -> None:
        self._modbus_total_events.append((ts if ts is not None else time.time(), is_exception))
        self._evict_modbus()

    def _evict_modbus(self, now: float | None = None) -> None:
        cutoff = (now if now is not None else time.time()) - self.window_s
        while self._modbus_total_events and self._modbus_total_events[0][0] < cutoff:
            self._modbus_total_events.popleft()

    def modbus_error_rate(self, now: float | None = None) -> float:
        self._evict_modbus(now)
        if not self._modbus_total_events:
            return 0.0
        errs = sum(1 for _, e in self._modbus_total_events if e)
        return errs / len(self._modbus_total_events)

    def modbus_exception_count(self, now: float | None = None) -> int:
        self._evict_modbus(now)
        return sum(1 for _, e in self._modbus_total_events if e)

    # ----- reconnect -----
    def mqtt_connect_seen(self, flow: Hashable) -> None:
        if flow in self._mqtt_connect_seen:
            self.reconnect_count += 1
        else:
            self._mqtt_connect_seen.add(flow)
