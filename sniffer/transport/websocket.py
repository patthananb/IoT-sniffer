"""WebSocket unframing for MQTT-over-WS flows.

Detects the `HTTP/1.1 101 Switching Protocols` upgrade on the flow, then
strips RFC 6455 frames from the post-upgrade bytes: 2-byte header, optional
2/8-byte extended length, optional 4-byte client mask, XOR unmask payload.
Control frames (ping/pong/close, opcode >= 0x8) are dropped; binary/text
payloads (0x1/0x2) and continuations (0x0) are concatenated across fragments.
"""

from __future__ import annotations

from dataclasses import dataclass, field


_UPGRADE_MARKER = b"HTTP/1.1 101"
_UPGRADE_END = b"\r\n\r\n"


@dataclass
class WebSocketUnmasker:
    """Consumes raw TCP bytes, emits unframed application payload."""

    upgraded: bool = False
    handshake_buf: bytearray = field(default_factory=bytearray)
    buf: bytearray = field(default_factory=bytearray)
    # Reassembly state for fragmented messages (opcode 0x0 continuations).
    fragments: bytearray = field(default_factory=bytearray)

    def feed(self, data: bytes) -> bytes:
        """Push raw TCP bytes. Return any application-layer bytes unmasked."""
        if not data:
            return b""

        if not self.upgraded:
            self.handshake_buf += data
            idx = self.handshake_buf.find(_UPGRADE_END)
            if idx < 0:
                # Not enough bytes yet to see end of handshake.
                return b""
            header = bytes(self.handshake_buf[: idx + 4])
            if _UPGRADE_MARKER not in header:
                # Not a websocket flow after all — drop.
                self.handshake_buf.clear()
                return b""
            self.upgraded = True
            tail = bytes(self.handshake_buf[idx + 4 :])
            self.handshake_buf.clear()
            self.buf += tail
        else:
            self.buf += data

        return self._drain()

    def _drain(self) -> bytes:
        out = bytearray()
        while True:
            frame = self._parse_frame()
            if frame is None:
                break
            fin, opcode, payload = frame
            if opcode >= 0x8:
                # Control frame — ignore.
                continue
            if opcode == 0x0:
                self.fragments += payload
            else:
                # New message — reset continuation buffer.
                self.fragments = bytearray(payload)
            if fin:
                out += self.fragments
                self.fragments = bytearray()
        return bytes(out)

    def _parse_frame(self) -> tuple[bool, int, bytes] | None:
        b = self.buf
        if len(b) < 2:
            return None
        b0, b1 = b[0], b[1]
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        plen = b1 & 0x7F
        off = 2
        if plen == 126:
            if len(b) < off + 2:
                return None
            plen = int.from_bytes(b[off : off + 2], "big")
            off += 2
        elif plen == 127:
            if len(b) < off + 8:
                return None
            plen = int.from_bytes(b[off : off + 8], "big")
            off += 8
        mask = b""
        if masked:
            if len(b) < off + 4:
                return None
            mask = bytes(b[off : off + 4])
            off += 4
        if len(b) < off + plen:
            return None
        payload = bytes(b[off : off + plen])
        if masked:
            payload = bytes(c ^ mask[i & 3] for i, c in enumerate(payload))
        del b[: off + plen]
        return fin, opcode, payload
