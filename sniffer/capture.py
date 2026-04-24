"""Live capture + TCP-stream reassembly → protocol decoders → metrics.

Uses scapy's `AsyncSniffer` on the interface given via `--iface`. A BPF
filter is built from the three port values so the kernel does the first
pass. Each TCP segment lands in `_handle_packet`, which:

  1. Picks the right per-flow `TCPStream` (initialising on first sight).
  2. Appends the payload; receives in-order bytes back.
  3. Runs either a direct protocol parser (Modbus, MQTT/TCP) or first
     unframes WS (MQTT/WS) and then parses MQTT.
  4. Emits decoded `Frame` objects through the supplied `publish` callback.

Correlation, latency, throughput and derived metrics are fed from the same
call site so everything stays in lockstep.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from scapy.all import AsyncSniffer, IP, TCP  # type: ignore

from .frame import Frame, flow_key, FlowTuple, reverse_flow
from .transport.tcp import TCPStream
from .transport.websocket import WebSocketUnmasker
from .protocols.mqtt import parse_mqtt, MQTTFrame
from .protocols.modbus import parse_modbus, ModbusFrame
from .metrics.latency import LatencyTracker
from .metrics.throughput import ThroughputRegistry
from .metrics.derived import DerivedMetrics
from .metrics.aggregator import PercentileAggregator


Publish = Callable[[Frame], None]


@dataclass
class FlowState:
    tcp_in: TCPStream = field(default_factory=TCPStream)
    # byte buffer after TCP reassembly, fed into protocol parser.
    parse_buf: bytearray = field(default_factory=bytearray)
    # WS only (MQTT/WS):
    ws: WebSocketUnmasker | None = None
    last_retransmits: int = 0


@dataclass
class CaptureConfig:
    iface: str
    modbus_port: int = 502
    mqtt_port: int = 1883
    mqttws_port: int = 8083

    def bpf(self) -> str:
        return f"tcp and (port {self.modbus_port} or port {self.mqtt_port} or port {self.mqttws_port})"


@dataclass
class CaptureEngine:
    cfg: CaptureConfig
    publish: Publish
    latency: LatencyTracker = field(default_factory=LatencyTracker)
    throughput: ThroughputRegistry = field(default_factory=lambda: ThroughputRegistry(window_s=1.0))
    derived: DerivedMetrics = field(default_factory=DerivedMetrics)
    aggregator: PercentileAggregator = field(default_factory=PercentileAggregator)

    flows: dict[FlowTuple, FlowState] = field(default_factory=dict)
    _sniffer: AsyncSniffer | None = None
    _started_at: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # ---- lifecycle ----
    def start(self) -> None:
        self._started_at = time.time()
        self._sniffer = AsyncSniffer(
            iface=self.cfg.iface,
            filter=self.cfg.bpf(),
            prn=self._on_packet,
            store=False,
        )
        self._sniffer.start()

    def stop(self) -> None:
        if self._sniffer is not None:
            try:
                self._sniffer.stop()
            except Exception:
                pass
            self._sniffer = None

    @property
    def duration_s(self) -> float:
        return time.time() - self._started_at if self._started_at else 0.0

    # ---- scapy callback ----
    def _on_packet(self, pkt) -> None:
        if IP not in pkt or TCP not in pkt:
            return
        ip = pkt[IP]
        tcp = pkt[TCP]
        payload = bytes(tcp.payload)
        flow = flow_key(ip.src, int(tcp.sport), ip.dst, int(tcp.dport))

        with self._lock:
            st = self.flows.get(flow)
            if st is None:
                st = FlowState()
                self.flows[flow] = st

            in_bytes = st.tcp_in.push(int(tcp.seq), payload)

            # Surface TCP retransmits into derived metrics.
            new_rx = st.tcp_in.retransmits - st.last_retransmits
            if new_rx:
                self.derived.add_retransmits(new_rx)
                st.last_retransmits = st.tcp_in.retransmits

            if not in_bytes:
                return

            proto, transport = self._classify(tcp)
            if proto is None:
                return

            if transport == "ws":
                if st.ws is None:
                    st.ws = WebSocketUnmasker()
                app_bytes = st.ws.feed(in_bytes)
                if not app_bytes:
                    return
                st.parse_buf += app_bytes
            else:
                st.parse_buf += in_bytes

            ts = float(pkt.time) if pkt.time else time.time()

            if proto == "modbus":
                self._drain_modbus(flow, st, ts)
            else:
                self._drain_mqtt(flow, st, ts, transport)

    def _classify(self, tcp) -> tuple[str | None, str | None]:
        ports = (int(tcp.sport), int(tcp.dport))
        if self.cfg.modbus_port in ports:
            return "modbus", "tcp"
        if self.cfg.mqtt_port in ports:
            return "mqtt", "tcp"
        if self.cfg.mqttws_port in ports:
            return "mqtt", "ws"
        return None, None

    # ---- decoders ----
    def _drain_modbus(self, flow: FlowTuple, st: FlowState, ts: float) -> None:
        while True:
            frame = parse_modbus(bytes(st.parse_buf))
            if frame is None:
                break
            del st.parse_buf[: frame.total_len]
            self._emit_modbus(flow, frame, ts)

    def _drain_mqtt(self, flow: FlowTuple, st: FlowState, ts: float, transport: str) -> None:
        while True:
            frame = parse_mqtt(bytes(st.parse_buf))
            if frame is None:
                break
            del st.parse_buf[: frame.total_len]
            self._emit_mqtt(flow, frame, ts, transport)

    # ---- emit + metrics ----
    def _emit_modbus(self, flow: FlowTuple, m: ModbusFrame, ts: float) -> None:
        latency_ms: float | None = None
        if m.is_exception or self._looks_like_response(m):
            latency_ms = self.latency.close(flow, m.tid, ts)
        else:
            self.latency.open(flow, m.tid, extra=None, ts=ts)

        if latency_ms is not None:
            self.aggregator.add(latency_ms)

        self.derived.modbus_seen(m.is_exception, ts)
        self.throughput.record(flow, m.total_len, topic=None, ts=ts)

        summary = self._modbus_summary(m)
        f = Frame(
            transport="tcp",
            protocol="modbus",
            pkt_type=("Exception" if m.is_exception else m.fc_name),
            correlation_id=m.tid,
            topic=None,
            qos=None,
            payload_bytes=list(m.data[:64]),
            payload_len=len(m.data),
            timestamp=ts,
            src_ip=flow[0], src_port=flow[1], dst_ip=flow[2], dst_port=flow[3],
            latency_ms=latency_ms,
            is_error=m.is_exception,
            raw_bytes=list(m.raw),
            field_map=m.field_map,
            summary=summary,
        )
        self.publish(f)

    def _emit_mqtt(self, flow: FlowTuple, m: MQTTFrame, ts: float, transport: str) -> None:
        latency_ms: float | None = None
        # Only QoS≥1 PUBLISH / SUBSCRIBE have correlation ids; responses close them.
        if m.type_code == 3 and m.qos > 0 and m.packet_id is not None:
            self.latency.open(flow, m.packet_id, extra=m.topic, ts=ts)
        elif m.type_code == 4 and m.packet_id is not None:  # PUBACK
            latency_ms = self.latency.close(flow, m.packet_id, ts)
        elif m.type_code == 7 and m.packet_id is not None:  # PUBCOMP (QoS2)
            latency_ms = self.latency.close(flow, m.packet_id, ts)
        elif m.type_code == 9 and m.packet_id is not None:  # SUBACK
            latency_ms = self.latency.close(flow, m.packet_id, ts)
        elif m.type_code == 8 and m.packet_id is not None:  # SUBSCRIBE
            self.latency.open(flow, m.packet_id, extra=m.topic, ts=ts)

        if m.type_code == 1:  # CONNECT
            self.derived.mqtt_connect_seen(flow)

        if m.type_code == 3 and m.topic:
            self.derived.mqtt_publish(m.topic, ts)

        if latency_ms is not None:
            self.aggregator.add(latency_ms)

        self.throughput.record(flow, m.total_len, topic=m.topic, ts=ts)

        proto_name = "mqtt-ws" if transport == "ws" else "mqtt-tcp"
        summary = self._mqtt_summary(m)
        f = Frame(
            transport=transport,
            protocol=proto_name,
            pkt_type=m.pkt_type,
            correlation_id=m.packet_id,
            topic=m.topic,
            qos=m.qos,
            payload_bytes=list(m.payload[:64]),
            payload_len=len(m.payload),
            timestamp=ts,
            src_ip=flow[0], src_port=flow[1], dst_ip=flow[2], dst_port=flow[3],
            latency_ms=latency_ms,
            is_error=False,
            raw_bytes=list(m.raw),
            field_map=m.field_map,
            summary=summary,
        )
        self.publish(f)

    # ---- helpers ----
    @staticmethod
    def _looks_like_response(m: ModbusFrame) -> bool:
        # Read-responses carry a byte count; writes echo addr+val.
        # The heuristic mirrors what a proxy would infer without per-flow state.
        if m.base_fc in (0x03, 0x04):
            return len(m.data) >= 1 and m.data[0] + 1 == len(m.data)
        if m.base_fc in (0x05, 0x06):
            return False  # write echo == request, treat as request
        return False

    @staticmethod
    def _modbus_summary(m: ModbusFrame) -> str:
        if m.is_exception and m.exception_code is not None:
            from .protocols.modbus import MODBUS_EXC
            return f"unit={m.unit_id} fc={m.base_fc} → {MODBUS_EXC.get(m.exception_code, '?')}"
        if m.base_fc in (0x03, 0x04) and len(m.data) == 4:
            start = int.from_bytes(m.data[0:2], "big")
            qty = int.from_bytes(m.data[2:4], "big")
            return f"unit={m.unit_id} addr=0x{start:04X} qty={qty}"
        if m.base_fc in (0x05, 0x06) and len(m.data) == 4:
            addr = int.from_bytes(m.data[0:2], "big")
            val = int.from_bytes(m.data[2:4], "big")
            return f"unit={m.unit_id} addr=0x{addr:04X} ← {val}"
        return f"unit={m.unit_id} {m.fc_name}"

    @staticmethod
    def _mqtt_summary(m: MQTTFrame) -> str:
        if m.type_code == 3 and m.topic is not None:
            prev = ""
            try:
                prev = m.payload.decode("utf-8")
            except UnicodeDecodeError:
                prev = m.payload[:24].hex()
            if len(prev) > 40:
                prev = prev[:40] + "…"
            return f"{m.topic} ← {prev}"
        if m.type_code == 8:
            return f"subscribe {m.topic or ''} qos={m.qos}"
        if m.type_code == 1:
            return f"connect cid={m.client_id or ''}"
        if m.type_code == 4:
            return f"ack pid={m.packet_id}"
        if m.type_code == 9:
            return f"subscribe ack pid={m.packet_id}"
        if m.type_code == 12:
            return "ping →"
        if m.type_code == 13:
            return "← pong"
        if m.type_code == 14:
            return "disconnect"
        return m.pkt_type.lower()

    # ---- snapshot for the metrics push tick ----
    def metrics_snapshot(self) -> dict[str, float | int]:
        bps, mps = self.throughput.global_rate()
        return {
            "ts": time.time(),
            "throughput_bps": bps,
            "throughput_mps": mps,
            "p50_ms": self.aggregator.p50,
            "p95_ms": self.aggregator.p95,
            "p99_ms": self.aggregator.p99,
            "error_rate": self.derived.modbus_error_rate(),
            "reconnect_count": self.derived.reconnect_count,
            "jitter_ms": self.derived.jitter_ms(),
            "modbus_exceptions": self.derived.modbus_exception_count(),
            "retransmits": self.derived.retransmits,
            "duration_s": self.duration_s,
        }
