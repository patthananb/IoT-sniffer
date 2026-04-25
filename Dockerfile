# Backend image for the IoT Sniffer.
#
# Runs `python -m sniffer.server` with scapy. Live capture needs raw-socket
# access on the host's network namespace, so the recommended runtime is
# `network_mode: host` + `cap_add: [NET_ADMIN, NET_RAW]` (see compose file).
FROM python:3.11-slim

# libpcap is used by scapy for BPF compilation; tcpdump is convenient for
# debugging from inside the container. Keep the layer small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpcap0.8 \
        tcpdump \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY sniffer ./sniffer

ENV PYTHONUNBUFFERED=1 \
    SNIFFER_IFACE=eth0 \
    SNIFFER_WS_PORT=8765 \
    SNIFFER_DB=/data/sniffer.db

EXPOSE 8765
VOLUME ["/data"]

ENTRYPOINT ["sh", "-c", "python -m sniffer.server \
    --iface ${SNIFFER_IFACE} \
    --ws-port ${SNIFFER_WS_PORT} \
    --db ${SNIFFER_DB} \
    ${SNIFFER_EXTRA_ARGS:-}"]
