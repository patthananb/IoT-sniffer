"""Modbus TCP binary parser.

MBAP header (7 bytes):
  [0:2] Transaction ID  (used as correlation key)
  [2:4] Protocol ID     (always 0 for Modbus)
  [4:6] Length          (remaining byte count = 1 + PDU)
  [6]   Unit Identifier
PDU:
  [7]   Function Code   (bit 0x80 set → exception response)
  [8:]  Data            (exception response has single exception byte)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


MODBUS_FC: dict[int, str] = {
    0x01: "Read Coils",
    0x02: "Read Discrete Inputs",
    0x03: "Read Holding Registers",
    0x04: "Read Input Registers",
    0x05: "Write Single Coil",
    0x06: "Write Single Register",
    0x0F: "Write Multiple Coils",
    0x10: "Write Multiple Registers",
    0x17: "Read/Write Multiple Registers",
}

MODBUS_EXC: dict[int, str] = {
    0x01: "ILLEGAL FUNCTION",
    0x02: "ILLEGAL DATA ADDRESS",
    0x03: "ILLEGAL DATA VALUE",
    0x04: "SLAVE DEVICE FAILURE",
    0x05: "ACKNOWLEDGE",
    0x06: "SLAVE DEVICE BUSY",
    0x08: "MEMORY PARITY ERROR",
    0x0A: "GATEWAY PATH UNAVAILABLE",
    0x0B: "GATEWAY TARGET NO RESPONSE",
}


@dataclass
class ModbusFrame:
    tid: int
    proto_id: int
    length: int
    unit_id: int
    function_code: int  # raw byte, may have 0x80 set
    base_fc: int        # function_code & 0x7F
    fc_name: str
    is_exception: bool
    exception_code: int | None
    data: bytes
    raw: bytes
    field_map: list[dict[str, Any]] = field(default_factory=list)
    total_len: int = 0


def parse_modbus(buf: bytes) -> ModbusFrame | None:
    if len(buf) < 8:
        return None
    tid = int.from_bytes(buf[0:2], "big")
    pid = int.from_bytes(buf[2:4], "big")
    length = int.from_bytes(buf[4:6], "big")
    total_len = 6 + length
    if length < 2 or len(buf) < total_len:
        return None
    unit = buf[6]
    fc_byte = buf[7]
    base_fc = fc_byte & 0x7F
    is_exc = bool(fc_byte & 0x80)
    fc_name = MODBUS_FC.get(base_fc, f"FC{base_fc:02X}")
    data = bytes(buf[8:total_len])

    fmap: list[dict[str, Any]] = [
        {"name": "Transaction ID", "desc": "MBAP header", "bytes": [0, 1],
         "value": f"0x{tid:04X}", "group": 0},
        {"name": "Protocol ID", "desc": "MBAP header", "bytes": [2, 3],
         "value": f"0x{pid:04X}" + (" (Modbus)" if pid == 0 else ""), "group": 0},
        {"name": "Length", "desc": "MBAP header", "bytes": [4, 5],
         "value": str(length), "group": 0},
        {"name": "Unit Identifier", "desc": "MBAP header", "bytes": [6],
         "value": str(unit), "group": 0},
        {"name": "Function Code", "desc": "PDU (exception)" if is_exc else "PDU",
         "bytes": [7],
         "value": f"0x{fc_byte:02X} ({fc_name})",
         "group": 5 if is_exc else 0},
    ]

    exc_code: int | None = None
    if is_exc and data:
        exc_code = data[0]
        fmap.append({"name": "Exception Code", "desc": "PDU",
                     "bytes": [8], "value": f"0x{exc_code:02X} {MODBUS_EXC.get(exc_code, '')}",
                     "group": 5})
    else:
        # Best-effort PDU annotation. Shape depends on FC and request/response.
        # For reads, a response carries a byte count at data[0]; request has
        # starting-address + quantity. Without direction we annotate generically.
        if base_fc in (0x01, 0x02, 0x03, 0x04) and len(data) == 4:
            start = int.from_bytes(data[0:2], "big")
            qty = int.from_bytes(data[2:4], "big")
            fmap += [
                {"name": "Starting Address", "desc": "PDU", "bytes": [8, 9],
                 "value": f"0x{start:04X} ({start})", "group": 3},
                {"name": "Quantity", "desc": "PDU", "bytes": [10, 11],
                 "value": str(qty), "group": 3},
            ]
        elif base_fc in (0x01, 0x02, 0x03, 0x04) and len(data) >= 1 and data[0] + 1 == len(data):
            byte_count = data[0]
            vals: list[int] = []
            for i in range(0, byte_count, 2):
                if i + 2 <= byte_count:
                    vals.append(int.from_bytes(data[1 + i : 3 + i], "big"))
            fmap += [
                {"name": "Byte Count", "desc": "PDU", "bytes": [8],
                 "value": str(byte_count), "group": 3},
                {"name": "Register Values", "desc": f"{len(vals)} × uint16",
                 "bytes": list(range(9, 9 + byte_count)),
                 "value": ", ".join(str(v) for v in vals[:3]) + (", …" if len(vals) > 3 else ""),
                 "group": 4},
            ]
        elif base_fc in (0x05, 0x06) and len(data) == 4:
            addr = int.from_bytes(data[0:2], "big")
            val = int.from_bytes(data[2:4], "big")
            fmap += [
                {"name": "Address", "desc": "PDU", "bytes": [8, 9],
                 "value": f"0x{addr:04X}", "group": 3},
                {"name": "Value", "desc": "PDU", "bytes": [10, 11],
                 "value": str(val), "group": 4},
            ]

    return ModbusFrame(
        tid=tid,
        proto_id=pid,
        length=length,
        unit_id=unit,
        function_code=fc_byte,
        base_fc=base_fc,
        fc_name=fc_name,
        is_exception=is_exc,
        exception_code=exc_code,
        data=data,
        raw=bytes(buf[:total_len]),
        field_map=fmap,
        total_len=total_len,
    )
