"""Per-protocol / per-flow detailed performance tracker.

Backs the "Performance" UI tab and the CSV export endpoint. Where the other
metrics modules expose single global aggregates (one p50, one jitter), this
one keeps **rolling sample windows** sliced by protocol and by flow tuple so
the UI can plot CDFs, time-series, and per-flow tables for scientific analysis.

Tracked, all rolling (FIFO) windows:

  - latency per protocol  (`latency_by_proto`, default 5 000 samples each)
  - latency per flow      (`latency_by_flow`,  default   500 samples each)
  - inter-arrival per protocol (`iat_by_proto`)
  - frame size per protocol (`size_by_proto`)
  - last `samples_window_s` seconds of (ts, latency, proto) for the chart

Plus per-flow byte/packet totals so the per-flow table can show throughput.

`snapshot()` returns a JSON-friendly dict pushed to the UI on a slower
cadence than the basic 1 Hz metrics tick (the payload is bigger). The same
samples back `export_csv_*()` for a one-click download from the UI.
"""

from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass, field

from ..frame import FlowTuple


@dataclass
class _RollingStats:
    """Rolling FIFO window of float samples + an all-time counter.

    Summary is computed on demand (sort + percentile pick) so adds are O(1)
    and only the periodic snapshot pays the O(n log n) sort.
    """

    max_samples: int = 5_000
    samples: deque[float] = field(default_factory=deque)
    total_seen: int = 0

    def add(self, v: float) -> None:
        self.samples.append(v)
        self.total_seen += 1
        while len(self.samples) > self.max_samples:
            self.samples.popleft()

    def summary(self) -> dict[str, float]:
        if not self.samples:
            return {
                "n": 0, "n_total": self.total_seen,
                "min": 0.0, "max": 0.0, "mean": 0.0, "stddev": 0.0,
                "p50": 0.0, "p90": 0.0, "p95": 0.0, "p99": 0.0,
            }
        s = sorted(self.samples)
        n = len(s)
        mean = sum(s) / n
        var = sum((x - mean) ** 2 for x in s) / n

        def pct(p: float) -> float:
            return s[min(n - 1, max(0, int(n * p)))]

        return {
            "n": n, "n_total": self.total_seen,
            "min": s[0], "max": s[-1], "mean": mean,
            "stddev": math.sqrt(var),
            "p50": pct(0.50), "p90": pct(0.90),
            "p95": pct(0.95), "p99": pct(0.99),
        }

    def cdf_points(self, max_points: int = 100) -> list[list[float]]:
        """Return `[[latency, cumulative_fraction], ...]` for plotting."""
        if not self.samples:
            return []
        s = sorted(self.samples)
        n = len(s)
        step = max(1, n // max_points)
        out: list[list[float]] = []
        for i in range(0, n, step):
            out.append([s[i], (i + 1) / n])
        if out[-1][0] != s[-1]:
            out.append([s[-1], 1.0])
        return out


@dataclass
class PerfTracker:
    max_per_proto: int = 5_000
    max_per_flow: int = 500
    samples_window_s: float = 300.0  # 5 min retention for the time-series chart
    flow_idle_s: float = 600.0       # forget flows silent for >10 min

    latency_by_proto: dict[str, _RollingStats] = field(default_factory=dict)
    iat_by_proto: dict[str, _RollingStats] = field(default_factory=dict)
    size_by_proto: dict[str, _RollingStats] = field(default_factory=dict)

    latency_by_flow: dict[FlowTuple, _RollingStats] = field(default_factory=dict)
    bytes_by_flow: dict[FlowTuple, int] = field(default_factory=dict)
    pkts_by_flow: dict[FlowTuple, int] = field(default_factory=dict)
    last_ts_by_flow: dict[FlowTuple, float] = field(default_factory=dict)
    proto_by_flow: dict[FlowTuple, str] = field(default_factory=dict)

    _last_ts_proto: dict[str, float] = field(default_factory=dict)
    recent: deque[tuple[float, float, str]] = field(default_factory=deque)

    def record(self, proto: str, flow: FlowTuple, ts: float, size: int,
               latency_ms: float | None) -> None:
        last = self._last_ts_proto.get(proto)
        if last is not None and ts > last:
            self._iat(proto).add((ts - last) * 1000.0)
        self._last_ts_proto[proto] = ts

        self._size(proto).add(float(size))

        if latency_ms is not None and latency_ms >= 0:
            self._latp(proto).add(latency_ms)
            self._latf(flow).add(latency_ms)
            self.recent.append((ts, latency_ms, proto))

        self.bytes_by_flow[flow] = self.bytes_by_flow.get(flow, 0) + size
        self.pkts_by_flow[flow] = self.pkts_by_flow.get(flow, 0) + 1
        self.last_ts_by_flow[flow] = ts
        self.proto_by_flow[flow] = proto

        cutoff = ts - self.samples_window_s
        while self.recent and self.recent[0][0] < cutoff:
            self.recent.popleft()

    def expire_flows(self, now: float | None = None) -> int:
        cutoff = (now if now is not None else time.time()) - self.flow_idle_s
        stale = [f for f, t in self.last_ts_by_flow.items() if t < cutoff]
        for f in stale:
            self.latency_by_flow.pop(f, None)
            self.bytes_by_flow.pop(f, None)
            self.pkts_by_flow.pop(f, None)
            self.last_ts_by_flow.pop(f, None)
            self.proto_by_flow.pop(f, None)
        return len(stale)

    def _latp(self, proto: str) -> _RollingStats:
        r = self.latency_by_proto.get(proto)
        if r is None:
            r = _RollingStats(max_samples=self.max_per_proto)
            self.latency_by_proto[proto] = r
        return r

    def _iat(self, proto: str) -> _RollingStats:
        r = self.iat_by_proto.get(proto)
        if r is None:
            r = _RollingStats(max_samples=self.max_per_proto)
            self.iat_by_proto[proto] = r
        return r

    def _size(self, proto: str) -> _RollingStats:
        r = self.size_by_proto.get(proto)
        if r is None:
            r = _RollingStats(max_samples=self.max_per_proto)
            self.size_by_proto[proto] = r
        return r

    def _latf(self, flow: FlowTuple) -> _RollingStats:
        r = self.latency_by_flow.get(flow)
        if r is None:
            r = _RollingStats(max_samples=self.max_per_flow)
            self.latency_by_flow[flow] = r
        return r

    def snapshot(self) -> dict:
        protos = (
            set(self.latency_by_proto)
            | set(self.iat_by_proto)
            | set(self.size_by_proto)
        )
        per_proto: dict[str, dict] = {}
        for p in sorted(protos):
            per_proto[p] = {
                "latency_ms": self._latp(p).summary(),
                "iat_ms": self._iat(p).summary(),
                "size_bytes": self._size(p).summary(),
                "cdf": self._latp(p).cdf_points(80),
            }

        per_flow: list[dict] = []
        for flow, lr in self.latency_by_flow.items():
            per_flow.append({
                "flow": list(flow),
                "protocol": self.proto_by_flow.get(flow, ""),
                "latency_ms": lr.summary(),
                "bytes": int(self.bytes_by_flow.get(flow, 0)),
                "packets": int(self.pkts_by_flow.get(flow, 0)),
                "last_ts": self.last_ts_by_flow.get(flow, 0.0),
            })

        for flow, n in self.pkts_by_flow.items():
            if flow not in self.latency_by_flow:
                per_flow.append({
                    "flow": list(flow),
                    "protocol": self.proto_by_flow.get(flow, ""),
                    "latency_ms": _RollingStats().summary(),
                    "bytes": int(self.bytes_by_flow.get(flow, 0)),
                    "packets": int(n),
                    "last_ts": self.last_ts_by_flow.get(flow, 0.0),
                })

        return {
            "per_proto": per_proto,
            "per_flow": per_flow,
            "ts_series": self._timeseries(bucket_s=5.0),
            "window_s": self.samples_window_s,
        }

    def _timeseries(self, bucket_s: float = 5.0) -> dict[str, list[dict]]:
        """Bucket recent (ts, latency, proto) samples for a time-series chart."""
        if not self.recent:
            return {}
        buckets: dict[tuple[str, int], list[float]] = {}
        for ts, lat, proto in self.recent:
            b = int(ts // bucket_s) * int(bucket_s)
            buckets.setdefault((proto, b), []).append(lat)
        out: dict[str, list[dict]] = {}
        for (proto, b), lats in sorted(buckets.items(), key=lambda x: (x[0][0], x[0][1])):
            lats.sort()
            n = len(lats)
            out.setdefault(proto, []).append({
                "ts": float(b),
                "n": n,
                "mean": sum(lats) / n,
                "p50": lats[min(n - 1, n // 2)],
                "p95": lats[min(n - 1, int(n * 0.95))],
                "p99": lats[min(n - 1, int(n * 0.99))],
            })
        return out

    def export_samples_csv(self) -> str:
        """One row per latency sample currently in the rolling window."""
        lines = ["timestamp,protocol,latency_ms"]
        for ts, lat, proto in self.recent:
            lines.append(f"{ts:.6f},{proto},{lat:.4f}")
        return "\n".join(lines) + "\n"

    def export_per_flow_csv(self) -> str:
        """One row per active flow with summary stats."""
        cols = (
            "src_ip,src_port,dst_ip,dst_port,protocol,packets,bytes,"
            "latency_n,latency_min_ms,latency_mean_ms,latency_p50_ms,"
            "latency_p95_ms,latency_p99_ms,latency_max_ms,latency_stddev_ms,last_ts"
        )
        lines = [cols]
        for entry in self.snapshot()["per_flow"]:
            f = entry["flow"]
            l = entry["latency_ms"]
            lines.append(
                f"{f[0]},{f[1]},{f[2]},{f[3]},{entry['protocol']},"
                f"{entry['packets']},{entry['bytes']},"
                f"{l['n']},{l['min']:.4f},{l['mean']:.4f},{l['p50']:.4f},"
                f"{l['p95']:.4f},{l['p99']:.4f},{l['max']:.4f},{l['stddev']:.4f},"
                f"{entry['last_ts']:.6f}"
            )
        return "\n".join(lines) + "\n"
