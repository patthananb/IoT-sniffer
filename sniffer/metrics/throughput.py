"""Sliding-window bytes/s and msg/s counters.

A single `ThroughputWindow` holds a deque of `(ts, bytes, msgs)` events and,
on `rate()`, discards anything older than `window_s` (default 1.0 s) then
returns `(bytes_per_s, msgs_per_s)`. A `ThroughputRegistry` fans out to one
window per flow tuple and one per MQTT topic so the UI can slice either way.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Hashable


@dataclass
class ThroughputWindow:
    window_s: float = 1.0
    events: deque[tuple[float, int, int]] = field(default_factory=deque)  # (ts, bytes, msgs)

    def add(self, byte_count: int, msgs: int = 1, ts: float | None = None) -> None:
        self.events.append((ts if ts is not None else time.time(), byte_count, msgs))

    def _evict(self, now: float) -> None:
        cutoff = now - self.window_s
        while self.events and self.events[0][0] < cutoff:
            self.events.popleft()

    def rate(self, now: float | None = None) -> tuple[float, float]:
        now = now if now is not None else time.time()
        self._evict(now)
        if not self.events:
            return 0.0, 0.0
        total_b = sum(e[1] for e in self.events)
        total_m = sum(e[2] for e in self.events)
        return total_b / self.window_s, total_m / self.window_s


@dataclass
class ThroughputRegistry:
    window_s: float = 1.0
    per_flow: dict[Hashable, ThroughputWindow] = field(default_factory=dict)
    per_topic: dict[str, ThroughputWindow] = field(default_factory=dict)
    global_win: ThroughputWindow = field(default_factory=ThroughputWindow)

    def __post_init__(self) -> None:
        self.global_win.window_s = self.window_s

    def _window(self, store: dict, key: Hashable) -> ThroughputWindow:
        w = store.get(key)
        if w is None:
            w = ThroughputWindow(window_s=self.window_s)
            store[key] = w
        return w

    def record(self, flow: Hashable, byte_count: int, topic: str | None = None,
               ts: float | None = None) -> None:
        self.global_win.add(byte_count, 1, ts)
        self._window(self.per_flow, flow).add(byte_count, 1, ts)
        if topic:
            self._window(self.per_topic, topic).add(byte_count, 1, ts)

    def global_rate(self, now: float | None = None) -> tuple[float, float]:
        return self.global_win.rate(now)
