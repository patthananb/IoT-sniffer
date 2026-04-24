"""Canonical decoded-frame dataclass pushed to the UI over WebSocket."""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Frame:
    """One decoded application-layer message.

    transport      — "tcp" | "ws"
    protocol       — "modbus" | "mqtt-tcp" | "mqtt-ws"
    pkt_type       — protocol-specific message name (e.g. "PUBLISH", "Read Holding Registers")
    correlation_id — Modbus TID, MQTT packet id, or None
    topic          — MQTT topic (None for non-PUBLISH / Modbus)
    qos            — MQTT QoS (0/1/2) or None
    payload_bytes  — preview of payload (first 64 bytes as list[int]) for hex view
    payload_len    — full payload length in bytes
    timestamp      — Unix seconds, float
    src/dst        — IPv4 + port
    latency_ms     — matched request→response latency, None until matched
    is_error       — Modbus exception / MQTT reason-code error
    raw_bytes      — full frame bytes as list[int] (for hex view / pcap)
    field_map      — list of {name, desc, bytes, value, group} for the decode drawer
    summary        — human-readable one-liner
    """

    transport: str
    protocol: str
    pkt_type: str
    correlation_id: int | None
    topic: str | None
    qos: int | None
    payload_bytes: list[int]
    payload_len: int
    timestamp: float
    src_ip: str
    src_port: int
    dst_ip: str
    dst_port: int
    latency_ms: float | None = None
    is_error: bool = False
    raw_bytes: list[int] = field(default_factory=list)
    field_map: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""

    @classmethod
    def now(cls, **kw) -> "Frame":
        kw.setdefault("timestamp", time.time())
        return cls(**kw)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


FlowTuple = tuple[str, int, str, int]  # (src_ip, src_port, dst_ip, dst_port)


def flow_key(src_ip: str, src_port: int, dst_ip: str, dst_port: int) -> FlowTuple:
    return (src_ip, src_port, dst_ip, dst_port)


def reverse_flow(f: FlowTuple) -> FlowTuple:
    return (f[2], f[3], f[0], f[1])
