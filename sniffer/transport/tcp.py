"""Per-flow TCP stream reassembly.

`TCPStream` buffers out-of-order scapy TCP segments by sequence number and
emits in-order bytes. The sniffer feeds those bytes into either a direct
protocol parser (Modbus, MQTT/TCP) or the WebSocket unmasker (MQTT/WS).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class TCPStream:
    """Reassemble one direction of a TCP flow.

    Scapy delivers segments unordered on loss/retransmit; we buffer by seq
    and drain contiguous bytes as they land. On a seq regression we flag a
    retransmit for derived metrics.
    """

    initial_seq: int | None = None
    next_seq: int | None = None
    pending: dict[int, bytes] = field(default_factory=dict)
    retransmits: int = 0
    bytes_seen: int = 0
    last_seq: int | None = None

    def push(self, seq: int, payload: bytes) -> bytes:
        """Add a segment. Return any newly in-order bytes (possibly b'')."""
        if not payload:
            return b""
        if self.initial_seq is None:
            self.initial_seq = seq
            self.next_seq = seq

        if self.last_seq is not None and seq < self.last_seq:
            self.retransmits += 1
        self.last_seq = seq

        # Duplicate / already-consumed segment.
        if seq + len(payload) <= self.next_seq:
            self.retransmits += 1
            return b""

        # Trim left overlap.
        if seq < self.next_seq:
            off = self.next_seq - seq
            payload = payload[off:]
            seq = self.next_seq

        self.pending[seq] = payload
        self.bytes_seen += len(payload)

        # Drain contiguous.
        out = bytearray()
        while self.next_seq in self.pending:
            chunk = self.pending.pop(self.next_seq)
            out += chunk
            self.next_seq += len(chunk)
        return bytes(out)


def passthrough(stream: TCPStream, seq: int, payload: bytes) -> bytes:
    """Thin wrapper for consistency with the websocket layer."""
    return stream.push(seq, payload)
