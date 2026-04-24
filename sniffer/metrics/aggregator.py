"""Rolling percentile aggregator using `sortedcontainers.SortedList`.

We cap at `max_samples` (default 10 000): on overflow we pop the oldest from
a FIFO shadow deque and remove that exact value from the sorted list. This
keeps p50/p95/p99 O(log n) per add and O(log n) per lookup, which is plenty
for the 1 Hz metrics tick.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from sortedcontainers import SortedList


@dataclass
class PercentileAggregator:
    max_samples: int = 10_000
    _sl: SortedList = field(default_factory=SortedList)
    _order: deque[float] = field(default_factory=deque)

    def add(self, value: float) -> None:
        self._sl.add(value)
        self._order.append(value)
        if len(self._order) > self.max_samples:
            oldest = self._order.popleft()
            # remove the first occurrence
            idx = self._sl.index(oldest)
            del self._sl[idx]

    def __len__(self) -> int:
        return len(self._sl)

    def percentile(self, pct: float) -> float:
        n = len(self._sl)
        if n == 0:
            return 0.0
        idx = min(n - 1, max(0, int(n * pct)))
        return float(self._sl[idx])

    @property
    def p50(self) -> float:
        return self.percentile(0.50)

    @property
    def p95(self) -> float:
        return self.percentile(0.95)

    @property
    def p99(self) -> float:
        return self.percentile(0.99)

    def snapshot(self) -> dict[str, float]:
        return {"p50": self.p50, "p95": self.p95, "p99": self.p99, "n": float(len(self._sl))}

    def clear(self) -> None:
        self._sl.clear()
        self._order.clear()
