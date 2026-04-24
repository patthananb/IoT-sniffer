# IoT Sniffer

Real-time sniffer and dashboard for industrial-IoT protocols:

- **Modbus TCP** (default port 502)
- **MQTT over TCP** (default port 1883)
- **MQTT over WebSocket** (default port 8083)

The backend is a Python package that captures traffic on a named network
interface with scapy, reassembles TCP streams per flow, decodes frames
with pure-Python parsers (no external protocol libraries), computes live
metrics (throughput, p50/p95/p99 latency, MQTT jitter, TCP retransmits,
Modbus error rate, MQTT reconnects) and pushes both decoded frames and a
1 Hz metrics snapshot to the browser over WebSocket. The frontend is a
three-panel dark-theme dashboard served as static HTML.

```
┌──────────────── sniffer package ────────────────┐        ┌──────── frontend ────────┐
│                                                 │        │                          │
│ capture.py ──► transport/{tcp,websocket}.py     │        │  index.html              │
│          └──► protocols/{modbus,mqtt}.py        │        │  app.jsx                 │
│          └──► metrics/*                         │ ws:8765│  live.jsx  ◄─ ws frames  │
│          └──► store.py (SQLite WAL + ring)      │◄──────►│  sim.jsx   (demo mode)   │
│          └──► server.py (websockets push)       │        │  styles.css              │
└─────────────────────────────────────────────────┘        └──────────────────────────┘
```

## Requirements

- Python 3.11+
- `scapy` for capture (`AsyncSniffer`)
- `websockets` for the push server
- `sortedcontainers` for the percentile aggregator

Packet capture needs raw-socket permission:

- **Linux**: run as root, or grant once with
  `sudo setcap cap_net_raw,cap_net_admin=eip $(readlink -f $(which python3))`
- **macOS**: ensure your user is in group `access_bpf`, or run with sudo
  (`sudo python -m sniffer.server ...`)
- **Windows**: install Npcap and run the shell as Administrator

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run the backend

```bash
python -m sniffer.server --iface eth0
```

Optional flags:

| Flag              | Default     | Meaning                                   |
| ----------------- | ----------- | ----------------------------------------- |
| `--iface`         | *(required)* | Capture interface (e.g. `eth0`, `en0`, `any`) |
| `--modbus-port`   | `502`       | Modbus TCP port                           |
| `--mqtt-port`     | `1883`      | MQTT over TCP port                        |
| `--mqttws-port`   | `8083`      | MQTT over WebSocket port                  |
| `--ws-host`       | `0.0.0.0`   | Push server bind host                     |
| `--ws-port`       | `8765`      | Push server port                          |
| `--db`            | `sniffer.db`| SQLite database path                      |
| `--log-level`     | `INFO`      | Python logging level                      |

The BPF filter applied at kernel level is:

```
tcp and (port 502 or port 1883 or port 8083)
```

## Run the frontend

The frontend is static — any local HTTP server works. From the repo root:

```bash
cd frontend
python3 -m http.server 8080
```

Then open <http://localhost:8080/>.

- Live mode (default) connects to `ws://localhost:8765`. A banner in the
  bottom-right shows the connection state and auto-reconnects.
- Demo mode: append `?demo=1` to the URL to use the built-in synthesizer
  — useful when you want to see the UI without running capture.

## WebSocket push format

The server pushes two message types to every connected client:

```jsonc
// one per decoded application-layer frame
{
  "type": "frame",
  "data": {
    "transport": "tcp" | "ws",
    "protocol":  "modbus" | "mqtt-tcp" | "mqtt-ws",
    "pkt_type":  "PUBLISH",             // protocol-specific
    "correlation_id": 123,              // TID (Modbus) / pkt id (MQTT), or null
    "topic": "factory/line1/temp",      // MQTT PUBLISH only, else null
    "qos": 1,                           // MQTT only, else null
    "payload_bytes": [0x7b, ...],       // up to 64 bytes
    "payload_len": 38,
    "timestamp": 1761234567.432,
    "src_ip": "10.0.4.21", "src_port": 55678,
    "dst_ip": "10.0.4.20", "dst_port": 1883,
    "latency_ms": 4.21,                 // null until request/response matched
    "is_error": false,
    "raw_bytes": [...],                 // full frame for hex view / pcap
    "field_map": [ {name, desc, bytes:[...], value, group}, ... ],
    "summary": "factory/line1/temp ← {...}"
  }
}

// one every 1000 ms
{
  "type": "metrics",
  "data": {
    "ts": 1761234567.43,
    "throughput_bps": 12845.7,
    "throughput_mps": 38.0,
    "p50_ms": 3.9, "p95_ms": 14.1, "p99_ms": 27.8,
    "error_rate": 0.04,                 // 60-s Modbus exception ratio
    "reconnect_count": 3,               // cumulative MQTT CONNECTs beyond first
    "jitter_ms": 0.82,                  // RFC 3550 MAD avg across topics
    "modbus_exceptions": 6,             // 60-s count
    "retransmits": 2,
    "duration_s": 222
  }
}
```

On connect, the server backfills the last ~200 frames from the in-memory
ring buffer so a freshly opened tab isn't blank.

## Architecture notes

- **Capture**: scapy `AsyncSniffer` runs on its own thread; the BPF filter
  is compiled from the three port values so the kernel pre-filters.
- **Flow reassembly**: one `TCPStream` per `(src_ip, src_port, dst_ip, dst_port)`
  direction. Segments are buffered by sequence number; contiguous bytes
  drain in order. Sequence regressions bump the retransmit counter used
  by the `derived` metrics.
- **Transport split**: Modbus (port 502) and MQTT/TCP (1883) feed the
  reassembled bytes straight into the protocol parser. MQTT/WS (8083)
  first runs through `transport.websocket.WebSocketUnmasker`, which
  detects the `HTTP/1.1 101` upgrade, strips RFC 6455 frame headers and
  XOR-unmasks the payload.
- **Protocol parsing**: pure-Python, dataclass-returning. MQTT decodes
  the fixed-header byte 0 split and the 1–4 byte variable-length
  remaining-length; Modbus decodes the 7-byte MBAP header and flags
  exceptions when the function code's high bit is set (`fc & 0x80`).
- **Latency**: `(flow, correlation_id)` → timestamp. Matching response
  pops and yields the delta in ms. Stale entries (>5 s) are swept on
  every metrics tick.
- **Percentiles**: `SortedList` capped at 10 000 samples, FIFO eviction.
  p50/p95/p99 are O(log n) to update and O(1) to read.
- **Persistence**: SQLite in WAL mode with `packets` + `metrics` tables.
  Writes happen on a background thread so the capture thread never
  blocks on disk. An in-memory `deque(maxlen=50000)` provides fast
  backfill for new UI clients.

## Project layout

```
iot-sniffer/
├── README.md
├── requirements.txt
├── sniffer/
│   ├── __init__.py
│   ├── capture.py               # AsyncSniffer + flow dispatch
│   ├── frame.py                 # canonical decoded-frame dataclass
│   ├── server.py                # CLI + asyncio websockets push server
│   ├── store.py                 # SQLite WAL + ring buffer
│   ├── transport/
│   │   ├── tcp.py               # per-flow stream reassembly
│   │   └── websocket.py         # HTTP/1.1 101 upgrade + frame strip + XOR unmask
│   ├── protocols/
│   │   ├── modbus.py            # MBAP + PDU + exception detection
│   │   └── mqtt.py              # VLQ + CONNECT/PUBLISH/SUBSCRIBE/SUBACK/PUBACK/PUBCOMP/PINGREQ/DISCONNECT
│   └── metrics/
│       ├── latency.py           # pending request map, 5 s expiry
│       ├── throughput.py        # sliding 1 s deque, per-flow and per-topic
│       ├── derived.py           # jitter (RFC 3550), retransmits, error/reconnect rates
│       └── aggregator.py        # SortedList p50/p95/p99, 10 000 max
└── frontend/
    ├── index.html
    ├── styles.css
    ├── app.jsx                  # React dashboard
    ├── live.jsx                 # WebSocket bridge (default)
    └── sim.jsx                  # demo-mode synthesizer (?demo=1)
```

## Development tips

- `python -c "import sniffer.server"` — fastest way to catch import errors
  after an edit.
- Run the frontend in demo mode (`?demo=1`) while iterating on UI so you
  don't need the backend or a live network.
- The ring buffer is per-process: restart the server to clear it. The
  SQLite file (`sniffer.db`) accumulates indefinitely — delete it or
  change `--db` between sessions.
