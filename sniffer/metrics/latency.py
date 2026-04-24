"""Request → response latency matching.

A `pending` dict keyed by `(flow_tuple, correlation_id)` holds the timestamp
of an outstanding request. When the matching response lands we pop, compute
the delta, and feed it to the percentile aggregator. Unmatched entries older
than `stale_after_s` (default 5s) are swept on every `expire()` call so we
don't leak memory on dropped responses.

Modbus: correlation_id = TID.
MQTT QoS 1/2: correlation_id = packet_id.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from ..frame import FlowTuple, reverse_flow


Key = tuple[FlowTuple, int]


@dataclass
class PendingEntry:
    ts: float
    extra: Any = None  # caller-owned payload (e.g. the request Frame)


@dataclass
class LatencyTracker:
    stale_after_s: float = 5.0
    pending: dict[Key, PendingEntry] = field(default_factory=dict)
    matched: int = 0
    expired: int = 0

    def open(self, flow: FlowTuple, corr_id: int, extra: Any = None, ts: float | None = None) -> None:
        self.pending[(flow, corr_id)] = PendingEntry(ts if ts is not None else time.time(), extra)

    def close(self, flow: FlowTuple, corr_id: int, ts: float | None = None) -> float | None:
        """Close a pending request matched by the response's own flow direction.

        The response's flow tuple is the request flow reversed, so we try both
        directions before giving up.
        """
        now = ts if ts is not None else time.time()
        for k in ((flow, corr_id), (reverse_flow(flow), corr_id)):
            e = self.pending.pop(k, None)
            if e is not None:
                self.matched += 1
                return (now - e.ts) * 1000.0
        return None

    def expire(self, now: float | None = None) -> int:
        """Drop entries older than `stale_after_s`. Returns count removed."""
        cutoff = (now if now is not None else time.time()) - self.stale_after_s
        stale = [k for k, v in self.pending.items() if v.ts < cutoff]
        for k in stale:
            self.pending.pop(k, None)
        self.expired += len(stale)
        return len(stale)
