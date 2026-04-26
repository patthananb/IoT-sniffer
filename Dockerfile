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
    SNIFFER_WS_HOST=0.0.0.0 \
    SNIFFER_WS_PORT=8765 \
    SNIFFER_DB=/data/sniffer.db \
    SNIFFER_AUTH_TOKEN= \
    SNIFFER_ORIGINS=

EXPOSE 8765
VOLUME ["/data"]

# The CLI defaults --ws-host to 127.0.0.1 (safer for direct python users).
# In the container we re-expose 0.0.0.0 by default so the dashboard on another
# host can reach the WS. Combine with SNIFFER_AUTH_TOKEN + SNIFFER_ORIGINS for prod.
# SNIFFER_AUTH_TOKEN / SNIFFER_ORIGINS are read by argparse defaults and only
# need to be present in the environment.
ENTRYPOINT ["sh", "-c", "python -m sniffer.server \
    --iface ${SNIFFER_IFACE} \
    --ws-host ${SNIFFER_WS_HOST} \
    --ws-port ${SNIFFER_WS_PORT} \
    --db ${SNIFFER_DB} \
    ${SNIFFER_EXTRA_ARGS:-}"]
