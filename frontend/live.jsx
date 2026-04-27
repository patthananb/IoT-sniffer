// WebSocket bridge: connects to the Python backend's push server on :8765
// and exposes `window.Live` as { subscribe, disconnect, state }.
//
// Backend messages:
//   { type: "frame",   data: <Frame dict> }
//   { type: "metrics", data: <metrics snapshot> }
//   { type: "perf",    data: <perf snapshot> }
//   { type: "query_reply", request_id, kind, data | error }
//
// Outbound (UI → server):
//   { type: "query", request_id, query: "csv_samples" | "csv_per_flow"
//                                      | "csv_history" | "history", ... }
//
// `Frame` is normalised to the packet shape the existing React tree expects
// (see `sim.jsx` for the ground-truth field list).

(function () {
  // Token discovery: ?token=... in the page URL takes priority, otherwise
  // we fall back to a value previously cached in localStorage. Whenever a
  // URL token is supplied we mirror it into localStorage so a one-time
  // visit with ?token=... is enough — subsequent bare URLs on the same
  // browser pick it up automatically. The backend also accepts
  // Authorization: Bearer for non-browser clients.
  const _LS_KEY = 'iot-sniffer-token';
  const _urlToken = new URLSearchParams(location.search).get('token') || '';
  let _cached = '';
  try { _cached = localStorage.getItem(_LS_KEY) || ''; } catch (_) {}
  if (_urlToken && _urlToken !== _cached) {
    try { localStorage.setItem(_LS_KEY, _urlToken); } catch (_) {}
  }
  const _pageToken = _urlToken || _cached;
  const _qs = _pageToken ? `?token=${encodeURIComponent(_pageToken)}` : '';
  const _scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const DEFAULT_URL = `${_scheme}://${location.hostname || 'localhost'}:8765${_qs}`;

  const PROTO_LABEL = {
    'modbus': 'Modbus/TCP',
    'mqtt-tcp': 'MQTT/TCP',
    'mqtt-ws': 'MQTT/WS',
  };

  function frameToPacket(f) {
    // Backend timestamps are float seconds; the UI uses ms.
    const ts = (f.timestamp || 0) * 1000;
    const latency = typeof f.latency_ms === 'number' ? f.latency_ms : 0;
    const meta = {};
    if (f.topic) meta['Topic'] = f.topic;
    if (f.qos != null) meta['QoS'] = f.qos;
    if (f.correlation_id != null) {
      meta[f.protocol === 'modbus' ? 'TxID' : 'PktID'] =
        f.protocol === 'modbus' ? `0x${(f.correlation_id).toString(16).toUpperCase().padStart(4,'0')}` : f.correlation_id;
    }
    meta['Length'] = f.raw_bytes ? f.raw_bytes.length : (f.payload_len || 0);

    return {
      id: `${ts}-${f.correlation_id ?? Math.random()}-${f.src_port}`,
      ts,
      proto: f.protocol,
      protoLabel: PROTO_LABEL[f.protocol] || f.protocol,
      src: `${f.src_ip}:${f.src_port}`,
      dst: `${f.dst_ip}:${f.dst_port}`,
      type: f.pkt_type,
      summary: f.summary || '',
      latency,
      isError: !!f.is_error,
      bytes: f.raw_bytes || [],
      payloadBytes: f.payload_bytes || [],
      payloadLen: f.payload_len || 0,
      transport: f.transport || '',
      fieldMap: f.field_map || [],
      meta,
    };
  }

  class LiveConnection {
    constructor(url) {
      this.url = url || DEFAULT_URL;
      this.ws = null;
      this.state = 'connecting';
      this.listeners = {
        frame: new Set(), metrics: new Set(), perf: new Set(), state: new Set(),
      };
      this._retry = null;
      this._pending = new Map();  // request_id -> {resolve, reject, timer}
      this._reqSeq = 1;
      this._connect();
    }

    _connect() {
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        this._scheduleRetry();
        return;
      }
      this._setState('connecting');
      this.ws.onopen = () => this._setState('ok');
      this.ws.onclose = () => {
        this._setState('closed');
        this._scheduleRetry();
      };
      this.ws.onerror = () => this._setState('err');
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'frame') {
          const pkt = frameToPacket(msg.data);
          this.listeners.frame.forEach(fn => { try { fn(pkt); } catch {} });
        } else if (msg.type === 'metrics') {
          this.listeners.metrics.forEach(fn => { try { fn(msg.data); } catch {} });
        } else if (msg.type === 'perf') {
          this.listeners.perf.forEach(fn => { try { fn(msg.data); } catch {} });
        } else if (msg.type === 'query_reply') {
          const p = this._pending.get(msg.request_id);
          if (!p) return;
          this._pending.delete(msg.request_id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg);
        }
      };
    }

    _scheduleRetry() {
      if (this._retry) return;
      this._retry = setTimeout(() => {
        this._retry = null;
        this._connect();
      }, 1500);
    }

    _setState(s) {
      this.state = s;
      this.listeners.state.forEach(fn => { try { fn(s); } catch {} });
    }

    on(kind, fn) {
      this.listeners[kind].add(fn);
      return () => this.listeners[kind].delete(fn);
    }

    query(kind, params = {}, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== 1) {
          reject(new Error('socket not connected'));
          return;
        }
        const id = this._reqSeq++;
        const timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new Error('query timed out'));
        }, timeoutMs);
        this._pending.set(id, { resolve, reject, timer });
        try {
          this.ws.send(JSON.stringify({ type: 'query', request_id: id, query: kind, ...params }));
        } catch (e) {
          this._pending.delete(id);
          clearTimeout(timer);
          reject(e);
        }
      });
    }

    disconnect() {
      if (this.ws) try { this.ws.close(); } catch {}
      if (this._retry) { clearTimeout(this._retry); this._retry = null; }
      for (const p of this._pending.values()) clearTimeout(p.timer);
      this._pending.clear();
    }
  }

  window.Live = { LiveConnection, DEFAULT_URL, frameToPacket };
})();
