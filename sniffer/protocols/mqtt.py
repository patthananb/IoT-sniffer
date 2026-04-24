"""MQTT 3.1.1 binary parser.

Implements the fixed-header byte 0 split (`type = b[0] >> 4`,
`flags = b[0] & 0x0F`), the Variable-Length Quantity (VLQ) remaining-length
decode (1–4 bytes, RFC-equivalent), and the variable-header / payload
layout for the packet types listed below. On malformed or truncated input
`parse_mqtt()` returns `None` so the caller can keep buffering.

Covered packet types:
  CONNECT (1), PUBLISH (3), PUBACK (4), PUBCOMP (7), SUBSCRIBE (8),
  SUBACK (9), PINGREQ (12), DISCONNECT (14).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


MQTT_TYPES: dict[int, str] = {
    1: "CONNECT",
    2: "CONNACK",
    3: "PUBLISH",
    4: "PUBACK",
    5: "PUBREC",
    6: "PUBREL",
    7: "PUBCOMP",
    8: "SUBSCRIBE",
    9: "SUBACK",
    10: "UNSUBSCRIBE",
    11: "UNSUBACK",
    12: "PINGREQ",
    13: "PINGRESP",
    14: "DISCONNECT",
}


@dataclass
class MQTTFrame:
    pkt_type: str
    type_code: int
    flags: int
    qos: int
    retain: bool
    dup: bool
    packet_id: int | None
    topic: str | None
    payload: bytes
    client_id: str | None
    raw: bytes
    field_map: list[dict[str, Any]] = field(default_factory=list)
    total_len: int = 0  # full frame size (header + VLQ + remaining)


def _decode_vlq(buf: bytes, off: int) -> tuple[int, int] | None:
    """Return (value, bytes_consumed) for an MQTT VLQ starting at `buf[off]`."""
    multiplier = 1
    value = 0
    consumed = 0
    for _ in range(4):
        if off + consumed >= len(buf):
            return None
        b = buf[off + consumed]
        consumed += 1
        value += (b & 0x7F) * multiplier
        if not (b & 0x80):
            return value, consumed
        multiplier *= 128
    return None  # malformed: >4 bytes


def parse_mqtt(buf: bytes) -> MQTTFrame | None:
    """Parse a single MQTT control packet from the head of `buf`.

    Returns None if the buffer is truncated or malformed; the caller should
    then keep buffering (for truncation) or advance by 1 byte (for malformed).
    """
    if len(buf) < 2:
        return None

    b0 = buf[0]
    type_code = (b0 >> 4) & 0x0F
    flags = b0 & 0x0F
    pkt_type = MQTT_TYPES.get(type_code, f"RESERVED_{type_code}")

    vlq = _decode_vlq(buf, 1)
    if vlq is None:
        return None
    remaining, vlq_len = vlq
    total_len = 1 + vlq_len + remaining
    if len(buf) < total_len:
        return None

    body = buf[1 + vlq_len : 1 + vlq_len + remaining]

    qos = (flags >> 1) & 0x03
    retain = bool(flags & 0x01)
    dup = bool(flags & 0x08)

    packet_id: int | None = None
    topic: str | None = None
    client_id: str | None = None
    payload: bytes = b""
    fmap: list[dict[str, Any]] = [
        {"name": "Fixed Header", "desc": f"Type={pkt_type} QoS={qos}{' RETAIN' if retain else ''}",
         "bytes": [0], "value": f"0x{b0:02X}", "group": 0},
        {"name": "Remaining Length", "desc": "Fixed header · VLQ",
         "bytes": list(range(1, 1 + vlq_len)), "value": str(remaining), "group": 0},
    ]

    base = 1 + vlq_len  # absolute offset of body[0]

    try:
        if type_code == 3:  # PUBLISH
            if len(body) < 2:
                return None
            tlen = int.from_bytes(body[:2], "big")
            if len(body) < 2 + tlen:
                return None
            topic = body[2 : 2 + tlen].decode("utf-8", errors="replace")
            fmap.append({"name": "Topic Length", "desc": "Variable header",
                         "bytes": [base, base + 1], "value": str(tlen), "group": 1})
            fmap.append({"name": "Topic", "desc": "Variable header",
                         "bytes": list(range(base + 2, base + 2 + tlen)),
                         "value": topic, "group": 2})
            cursor = 2 + tlen
            if qos > 0:
                if len(body) < cursor + 2:
                    return None
                packet_id = int.from_bytes(body[cursor : cursor + 2], "big")
                fmap.append({"name": "Packet ID", "desc": "Variable header",
                             "bytes": [base + cursor, base + cursor + 1],
                             "value": str(packet_id), "group": 1})
                cursor += 2
            payload = body[cursor:]
            fmap.append({"name": "Payload", "desc": f"{len(payload)} bytes",
                         "bytes": list(range(base + cursor, base + cursor + len(payload))),
                         "value": _preview(payload), "group": 3})

        elif type_code == 1:  # CONNECT
            if len(body) < 2:
                return None
            pnlen = int.from_bytes(body[:2], "big")
            if len(body) < 2 + pnlen + 4:
                return None
            proto_name = body[2 : 2 + pnlen].decode("utf-8", errors="replace")
            cursor = 2 + pnlen
            level = body[cursor]
            cflags = body[cursor + 1]
            keepalive = int.from_bytes(body[cursor + 2 : cursor + 4], "big")
            cursor += 4
            cid_len = int.from_bytes(body[cursor : cursor + 2], "big")
            client_id = body[cursor + 2 : cursor + 2 + cid_len].decode("utf-8", errors="replace")
            fmap += [
                {"name": "Protocol Name", "desc": "Variable header",
                 "bytes": list(range(base, base + 2 + pnlen)),
                 "value": f'"{proto_name}"', "group": 1},
                {"name": "Protocol Level", "desc": "Variable header",
                 "bytes": [base + 2 + pnlen], "value": f"{level} (v{'3.1.1' if level == 4 else '5' if level == 5 else '?'})",
                 "group": 1},
                {"name": "Connect Flags", "desc": "Variable header",
                 "bytes": [base + 3 + pnlen], "value": f"0x{cflags:02X}", "group": 1},
                {"name": "Keep Alive", "desc": "Variable header",
                 "bytes": [base + 4 + pnlen, base + 5 + pnlen],
                 "value": f"{keepalive} s", "group": 1},
                {"name": "Client ID", "desc": "Payload",
                 "bytes": list(range(base + cursor, base + cursor + 2 + cid_len)),
                 "value": f'"{client_id}"', "group": 2},
            ]

        elif type_code in (4, 5, 6, 7, 11):  # PUBACK, PUBREC, PUBREL, PUBCOMP, UNSUBACK
            if len(body) < 2:
                return None
            packet_id = int.from_bytes(body[:2], "big")
            fmap.append({"name": "Packet ID", "desc": "Variable header",
                         "bytes": [base, base + 1], "value": str(packet_id), "group": 1})

        elif type_code == 8:  # SUBSCRIBE
            if len(body) < 2:
                return None
            packet_id = int.from_bytes(body[:2], "big")
            fmap.append({"name": "Packet ID", "desc": "Variable header",
                         "bytes": [base, base + 1], "value": str(packet_id), "group": 1})
            cursor = 2
            if len(body) >= cursor + 2:
                tlen = int.from_bytes(body[cursor : cursor + 2], "big")
                if len(body) >= cursor + 2 + tlen + 1:
                    topic = body[cursor + 2 : cursor + 2 + tlen].decode("utf-8", errors="replace")
                    req_qos = body[cursor + 2 + tlen]
                    fmap += [
                        {"name": "Topic Filter", "desc": "Payload",
                         "bytes": list(range(base + cursor, base + cursor + 2 + tlen)),
                         "value": f'"{topic}"', "group": 2},
                        {"name": "Requested QoS", "desc": "Payload",
                         "bytes": [base + cursor + 2 + tlen], "value": str(req_qos), "group": 2},
                    ]
                    qos = req_qos

        elif type_code == 9:  # SUBACK
            if len(body) < 2:
                return None
            packet_id = int.from_bytes(body[:2], "big")
            fmap.append({"name": "Packet ID", "desc": "Variable header",
                         "bytes": [base, base + 1], "value": str(packet_id), "group": 1})
            if len(body) >= 3:
                granted = body[2]
                fmap.append({"name": "Granted QoS", "desc": "Payload",
                             "bytes": [base + 2], "value": str(granted), "group": 2})

        elif type_code in (2,):  # CONNACK
            if len(body) >= 2:
                fmap.append({"name": "Ack Flags", "desc": "Variable header",
                             "bytes": [base], "value": f"0x{body[0]:02X}", "group": 1})
                fmap.append({"name": "Reason Code", "desc": "Variable header",
                             "bytes": [base + 1], "value": f"0x{body[1]:02X}", "group": 1})

        # PINGREQ (12), PINGRESP (13), DISCONNECT (14) have no variable body.
    except (IndexError, ValueError):
        return None

    return MQTTFrame(
        pkt_type=pkt_type,
        type_code=type_code,
        flags=flags,
        qos=qos,
        retain=retain,
        dup=dup,
        packet_id=packet_id,
        topic=topic,
        payload=payload,
        client_id=client_id,
        raw=bytes(buf[:total_len]),
        field_map=fmap,
        total_len=total_len,
    )


def _preview(payload: bytes, limit: int = 48) -> str:
    try:
        s = payload.decode("utf-8")
        if len(s) > limit:
            s = s[:limit] + "…"
        return s
    except UnicodeDecodeError:
        hx = payload[:limit].hex()
        return hx + ("…" if len(payload) > limit else "")
