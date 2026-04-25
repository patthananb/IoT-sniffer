const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ---------- helpers ----------
const fmtTime = (ms) => {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms3 = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms3}`;
};
const fmtDuration = (secs) => {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
};
const fmtBytes = (b) => {
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(2)} MB`;
};
const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

const QS = new URLSearchParams(location.search);
const DEMO = QS.has('demo');
const _qsTab = QS.get('tab');
const INITIAL_TAB = _qsTab === 'graph' ? 'graph' : _qsTab === 'perf' ? 'perf' : 'stream';
const MAX_PACKETS = 600;  // ring-buffer cap in the UI

// ---------- top bar ----------
function TopBar({ capturing, onClear, duration, totalBytes, totalPackets, theme, onToggleTheme }) {
  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark"></div>
        <span className="brand-name">IoT Sniffer</span>
        <span className="brand-sub">/ v1.4.0</span>
      </div>

      <div className="topbar-stats">
        <div className="stat">
          <div className="stat-label">Capture</div>
          <div className={"stat-value" + (capturing ? " live" : "")}>
            {capturing ? '● LIVE' : '○ IDLE'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Duration</div>
          <div className="stat-value">{fmtDuration(duration)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Packets</div>
          <div className="stat-value">{totalPackets.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Captured</div>
          <div className="stat-value">{fmtBytes(totalBytes)}</div>
        </div>
      </div>

      <div className="topbar-actions">
        <button
          className={"btn theme-toggle " + theme}
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span className="theme-toggle-mark"></span>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
        <button className="btn" onClick={onClear} title="Clear buffer">
          <svg className="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <path d="M3 5h10M6 5V3.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V5M5 5v8a1 1 0 001 1h4a1 1 0 001-1V5" strokeLinecap="round"/>
          </svg>
          Clear
        </button>
        <button className="btn primary">
          <svg className="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Export .pcap
        </button>
      </div>
    </div>
  );
}

// ---------- sidebar ----------
function Sidebar({
  iface, setIface, capturing, onToggle, onClear,
  enabledProtos, toggleProto, protoCounts,
  ports, setPort, connStatus,
}) {
  const interfaces = [
    { id: 'eth0', name: 'eth0', ip: '10.0.4.18', mac: 'b8:27:eb:a2:10:4c' },
    { id: 'eth1', name: 'eth1 (DMZ)', ip: '192.168.40.3', mac: 'b8:27:eb:a2:10:4d' },
    { id: 'wlan0', name: 'wlan0', ip: '10.0.4.22', mac: 'dc:a6:32:71:8f:0a' },
    { id: 'any', name: 'any (all interfaces)', ip: '—', mac: '—' },
  ];
  const current = interfaces.find(i => i.id === iface) || interfaces[0];

  const protos = [
    { id: 'modbus',   label: 'Modbus TCP', cls: 'modbus' },
    { id: 'mqtt-tcp', label: 'MQTT / TCP', cls: 'mqtt-tcp' },
    { id: 'mqtt-ws',  label: 'MQTT / WS',  cls: 'mqtt-ws' },
  ];

  return (
    <aside className="sidebar">
      <div className="sb-section">
        <h3 className="sb-title">Interface</h3>
        <select className="iface-select" value={iface} onChange={e => setIface(e.target.value)}>
          {interfaces.map(i => (
            <option key={i.id} value={i.id}>{i.name}</option>
          ))}
        </select>
        <div className="iface-meta">
          <span>{current.ip}</span>
          <span>{current.mac}</span>
        </div>
      </div>

      <div className="sb-section">
        <h3 className="sb-title">Capture</h3>
        <div className="capture-controls">
          <button
            className={"cap-btn start" + (capturing ? " capturing" : "")}
            onClick={onToggle}
          >
            <span className="icon"></span>
            {capturing ? 'Stop' : 'Start'}
          </button>
          <button className="cap-btn" onClick={onClear}>Clear</button>
          <button className="cap-btn">Pause</button>
        </div>
      </div>

      <div className="sb-section">
        <h3 className="sb-title">Protocols</h3>
        {protos.map(p => (
          <label
            key={p.id}
            className={"proto-row " + p.cls + (enabledProtos.has(p.id) ? " checked" : "")}
            onClick={e => { e.preventDefault(); toggleProto(p.id); }}
          >
            <input type="checkbox" readOnly checked={enabledProtos.has(p.id)} />
            <span className="proto-box"></span>
            <span className="proto-name">{p.label}</span>
            <span className="proto-count">{(protoCounts[p.id] || 0).toLocaleString()}</span>
          </label>
        ))}
      </div>

      <div className="sb-section">
        <h3 className="sb-title">Ports</h3>
        <div className="port-grid">
          <span className="port-lbl modbus">Modbus</span>
          <input className="port-input" value={ports.modbus}
                 onChange={e => setPort('modbus', e.target.value)} />
        </div>
        <div className="port-grid">
          <span className="port-lbl mqtt-tcp">MQTT</span>
          <input className="port-input" value={ports['mqtt-tcp']}
                 onChange={e => setPort('mqtt-tcp', e.target.value)} />
        </div>
        <div className="port-grid">
          <span className="port-lbl mqtt-ws">MQTT/WS</span>
          <input className="port-input" value={ports['mqtt-ws']}
                 onChange={e => setPort('mqtt-ws', e.target.value)} />
        </div>
      </div>

      <div className="sb-section">
        <h3 className="sb-title">Connections</h3>
        <div className="conn-row">
          <span className={"dot " + (connStatus.modbus === 'ok' ? 'ok' : connStatus.modbus === 'err' ? 'err' : '')}></span>
          <span className="conn-name">Modbus bus</span>
          <span className="conn-state">{connStatus.modbus === 'ok' ? 'SNIFFING' : connStatus.modbus === 'err' ? 'ERROR' : 'IDLE'}</span>
        </div>
        <div className="conn-row">
          <span className={"dot " + (connStatus['mqtt-tcp'] === 'ok' ? 'ok' : connStatus['mqtt-tcp'] === 'err' ? 'err' : '')}></span>
          <span className="conn-name">MQTT broker</span>
          <span className="conn-state">{connStatus['mqtt-tcp'] === 'ok' ? 'SNIFFING' : connStatus['mqtt-tcp'] === 'err' ? 'RECONNECT' : 'IDLE'}</span>
        </div>
        <div className="conn-row">
          <span className={"dot " + (connStatus['mqtt-ws'] === 'ok' ? 'ok' : connStatus['mqtt-ws'] === 'err' ? 'err' : '')}></span>
          <span className="conn-name">WS gateway</span>
          <span className="conn-state">{connStatus['mqtt-ws'] === 'ok' ? 'SNIFFING' : connStatus['mqtt-ws'] === 'err' ? 'ERROR' : 'IDLE'}</span>
        </div>
      </div>
    </aside>
  );
}

// ---------- packet list ----------
function PacketList({ packets, selectedId, onSelect, filter, setFilter, autoscroll, setAutoscroll }) {
  const scrollerRef = useRef(null);
  const shown = useMemo(() => {
    if (!filter) return packets;
    const q = filter.toLowerCase();
    return packets.filter(p =>
      p.src.toLowerCase().includes(q) ||
      p.dst.toLowerCase().includes(q) ||
      p.type.toLowerCase().includes(q) ||
      p.summary.toLowerCase().includes(q) ||
      p.protoLabel.toLowerCase().includes(q)
    );
  }, [packets, filter]);

  useEffect(() => {
    if (!autoscroll || !scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [shown.length, autoscroll]);

  return (
    <div className="table-wrap">
      <div className="center-head">
        <input
          className="search"
          placeholder="filter  e.g.  mqtt.topic == factory/line1  |  modbus.fc == 3  |  10.0.14.12"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <div className="head-meta">
          <span>{shown.length.toLocaleString()} / {packets.length.toLocaleString()}</span>
        </div>
        <label
          className={"autoscroll-toggle" + (autoscroll ? " on" : "")}
          onClick={() => setAutoscroll(!autoscroll)}
        >
          <span className="pill"></span>
          auto-scroll
        </label>
      </div>

      <div className="packet-list" ref={scrollerRef}>
        <div className="pkt-header">
          <div>Time</div>
          <div>Protocol</div>
          <div>Source</div>
          <div>Destination</div>
          <div>Type</div>
          <div>Summary</div>
          <div style={{textAlign:'right'}}>Latency</div>
        </div>
        {shown.length === 0 && (
          <div className="empty">
            <b>No packets yet.</b>
            waiting for the sniffer to push frames over ws://localhost:8765
          </div>
        )}
        {shown.map((p, i) => (
          <div
            key={p.id}
            className={
              "pkt-row " + p.proto +
              (p.isError ? " err" : "") +
              (p.id === selectedId ? " selected" : "") +
              (i >= shown.length - 3 ? " new" : "")
            }
            onClick={() => onSelect(p.id === selectedId ? null : p.id)}
          >
            <div className="col-time">{fmtTime(p.ts)}</div>
            <div className={"col-proto " + p.proto}>{p.protoLabel}</div>
            <div>{p.src}</div>
            <div>{p.dst}</div>
            <div className="col-type">{p.type}</div>
            <div className="col-summary">{p.summary}</div>
            <div className="col-latency">{(p.latency || 0).toFixed(1)}ms</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- decode drawer ----------
const isPrint = b => b >= 0x20 && b <= 0x7E;

function DecodeDrawer({ packet, onClose }) {
  const [hover, setHover] = useState(null);
  const [showAscii, setShowAscii] = useState(true);

  if (!packet) return null;
  const fieldMap = packet.fieldMap || [];
  const bytes = packet.bytes || [];
  const hoverBytes = new Set(hover !== null && fieldMap[hover] ? fieldMap[hover].bytes : []);

  const rows = [];
  const perRow = 16;
  for (let off = 0; off < bytes.length; off += perRow) {
    rows.push({ off, slice: bytes.slice(off, off + perRow) });
  }

  const byteGroup = new Array(bytes.length).fill(null);
  fieldMap.forEach((f, fi) => {
    (f.bytes || []).forEach(b => { if (byteGroup[b] == null) byteGroup[b] = { g: f.group, fi }; });
  });

  // Decode full payload bytes as UTF-8 for the ASCII panel
  const payloadField = fieldMap.find(f => f.name === 'Payload');
  const payloadBytes = payloadField ? (payloadField.bytes || []).map(i => bytes[i]).filter(b => b !== undefined) : [];
  let payloadAscii = '';
  try { payloadAscii = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(payloadBytes)); }
  catch { payloadAscii = payloadBytes.map(b => isPrint(b) ? String.fromCharCode(b) : '.').join(''); }

  return (
    <div className="drawer">
      <div className="drawer-head">
        <div className="drawer-title">
          <span className={"tag " + packet.proto}>{packet.protoLabel}</span>
          <span>{packet.type}</span>
          <span style={{color:'var(--text-muted)', fontWeight:400}}>·</span>
          <span style={{color:'var(--text-muted)', fontWeight:400}}>{packet.src} → {packet.dst}</span>
        </div>
        <div className="drawer-meta">
          {Object.entries(packet.meta || {}).map(([k,v]) => (
            <span key={k}>{k}: <b>{v}</b></span>
          ))}
          <span>Latency: <b>{(packet.latency || 0).toFixed(2)} ms</b></span>
        </div>
        <button className="drawer-close" onClick={onClose} title="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2 2l8 8M10 2l-8 8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      <div className="drawer-body">
        <div className="decode-col">
          <div className="decode-col-title">
            Hex · {bytes.length} bytes
            <button
              className={"ascii-toggle" + (showAscii ? " on" : "")}
              onClick={() => setShowAscii(v => !v)}
              title="Toggle ASCII column"
            >ASCII</button>
          </div>
          <div className="hex-view">
            {rows.map(r => (
              <div className="hex-line" key={r.off}>
                <span className="hex-offset">{hex(r.off, 4)}</span>
                <span className="hex-bytes">
                  {r.slice.map((b, i) => {
                    const abs = r.off + i;
                    const g = byteGroup[abs];
                    const cls = g ? `g-${g.g}` : '';
                    const hl = hoverBytes.has(abs) ? ' hover' : '';
                    return (
                      <span
                        key={i}
                        className={`hex-byte ${cls}${hl}`}
                        onMouseEnter={() => g && setHover(g.fi)}
                        onMouseLeave={() => setHover(null)}
                      >{hex(b)}</span>
                    );
                  })}
                </span>
                {showAscii && (
                  <span className="hex-ascii">
                    {r.slice.map((b, i) => {
                      const abs = r.off + i;
                      const g = byteGroup[abs];
                      const hl = hoverBytes.has(abs) ? ' hover' : '';
                      const print = isPrint(b);
                      return (
                        <span
                          key={i}
                          className={`hex-ascii-char${print ? '' : ' non-print'}${hl}`}
                          onMouseEnter={() => g && setHover(g.fi)}
                          onMouseLeave={() => setHover(null)}
                          title={`0x${hex(b)} = ${print ? String.fromCharCode(b) : 'non-printable'}`}
                        >{print ? String.fromCharCode(b) : '·'}</span>
                      );
                    })}
                  </span>
                )}
              </div>
            ))}
          </div>
          {payloadAscii && (
            <div className="ascii-payload">
              <div className="ascii-payload-title">Payload · decoded</div>
              <pre className="ascii-payload-body">{payloadAscii}</pre>
            </div>
          )}
        </div>

        <div className="decode-col">
          <div className="decode-col-title">Parsed fields</div>
          {fieldMap.map((f, i) => (
            <div
              key={i}
              className={"field" + (hover === i ? " hover" : "")}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={hover === i ? {background:'var(--bg-elev)'} : null}
            >
              <span className={`field-swatch g-${f.group}`}></span>
              <span className="field-name">
                <b>{f.name}</b>
                <em>{f.desc} · bytes [{(f.bytes||[])[0]}{(f.bytes||[]).length > 1 ? `–${f.bytes[f.bytes.length-1]}` : ''}]</em>
              </span>
              <span className="field-val">{f.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- throughput chart ----------
function ThroughputChart({ series }) {
  const W = 292, H = 132, PAD_L = 6, PAD_R = 6, PAD_T = 8, PAD_B = 14;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const maxB = Math.max(1, ...series.map(s => s.bytes));
  const maxM = Math.max(1, ...series.map(s => s.msgs));

  const bytePath = series.map((s, i) => {
    const x = PAD_L + (i / Math.max(1, series.length - 1)) * plotW;
    const y = PAD_T + (1 - s.bytes / maxB) * plotH;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const byteFill = bytePath
    ? bytePath + ` L${(PAD_L + plotW).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} L${PAD_L.toFixed(1)} ${(PAD_T + plotH).toFixed(1)} Z`
    : '';

  const msgPath = series.map((s, i) => {
    const x = PAD_L + (i / Math.max(1, series.length - 1)) * plotW;
    const y = PAD_T + (1 - s.msgs / maxM) * plotH;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');

  const last = series[series.length - 1] || { bytes: 0, msgs: 0 };

  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="bgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor="oklch(0.80 0.16 150)" stopOpacity="0.35"/>
            <stop offset="100%" stopColor="oklch(0.80 0.16 150)" stopOpacity="0"/>
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f}
            x1={PAD_L} x2={PAD_L + plotW}
            y1={PAD_T + f * plotH} y2={PAD_T + f * plotH}
            stroke="oklch(0.28 0.014 240)" strokeWidth="1" strokeDasharray="2 3"
          />
        ))}
        <line x1={PAD_L} x2={PAD_L + plotW} y1={PAD_T + plotH} y2={PAD_T + plotH}
          stroke="oklch(0.32 0.014 240)" strokeWidth="1"/>
        <path d={byteFill} fill="url(#bgrad)"/>
        <path d={bytePath} fill="none" stroke="oklch(0.80 0.16 150)" strokeWidth="1.6" strokeLinejoin="round"/>
        <path d={msgPath} fill="none" stroke="oklch(0.72 0.14 270)" strokeWidth="1.4" strokeLinejoin="round"/>
        <text x={PAD_L} y={H - 3} fontSize="9" fill="oklch(0.50 0.012 240)" fontFamily="JetBrains Mono">-60s</text>
        <text x={PAD_L + plotW / 2 - 8} y={H - 3} fontSize="9" fill="oklch(0.50 0.012 240)" fontFamily="JetBrains Mono">-30s</text>
        <text x={PAD_L + plotW - 14} y={H - 3} fontSize="9" fill="oklch(0.50 0.012 240)" fontFamily="JetBrains Mono">now</text>
      </svg>
      <div className="chart-legend">
        <span>bytes/s <b>{fmtBytes(last.bytes)}</b></span>
        <span className="msg">msg/s <b>{Math.round(last.msgs)}</b></span>
      </div>
    </>
  );
}

// ---------- right panel ----------
function RightPanel({ series, latency, errorRate, errorHist, mqttReconnects, modbusExceptions, topTalkers }) {
  const maxLat = Math.max(latency.p50, latency.p95, latency.p99, 1);
  return (
    <aside className="right">
      <div className="metric-section">
        <div className="metric-title">
          <span>Throughput</span>
          <span className="mt-note">60s rolling · 1 Hz</span>
        </div>
        <ThroughputChart series={series}/>
      </div>

      <div className="metric-section">
        <div className="metric-title">
          <span>Latency distribution</span>
          <span className="mt-note">last 60s</span>
        </div>
        {[{k:'p50',v:latency.p50},{k:'p95',v:latency.p95},{k:'p99',v:latency.p99}].map(({k, v}) => (
          <div className="lat-row" key={k}>
            <div className="lat-label">{k}</div>
            <div className="lat-track">
              <div className="lat-fill" style={{width: `${Math.min(100, (v / maxLat) * 100)}%`}}></div>
            </div>
            <div className="lat-val">{v.toFixed(1)}ms</div>
          </div>
        ))}
      </div>

      <div className="metric-section">
        <div className="metric-title">
          <span>Errors & reconnects</span>
        </div>
        <div className="counter-grid">
          <div className="counter full err">
            <div className="counter-lbl">Error rate · pkt/min</div>
            <div className="counter-val">{errorRate}</div>
            <div className="err-rate">
              {errorHist.map((h, i) => (
                <span key={i} style={{height: `${Math.max(4, h * 10)}%`, opacity: 0.4 + h * 0.1}}></span>
              ))}
            </div>
          </div>
          <div className="counter warn">
            <div className="counter-lbl">MQTT reconnects</div>
            <div className="counter-val">{mqttReconnects}</div>
            <div className="counter-delta">since start</div>
          </div>
          <div className="counter err">
            <div className="counter-lbl">Modbus exc.</div>
            <div className="counter-val">{modbusExceptions}</div>
            <div className="counter-delta">last 60s</div>
          </div>
        </div>
      </div>

      <div className="metric-section" style={{flex:1, borderBottom:0}}>
        <div className="metric-title">
          <span>Top talkers</span>
          <span className="mt-note">by packets</span>
        </div>
        <TopTalkers data={topTalkers}/>
      </div>
    </aside>
  );
}

function TopTalkers({ data }) {
  const colorFor = {
    'modbus': 'var(--modbus)',
    'mqtt-tcp': 'var(--mqtt-tcp)',
    'mqtt-ws': 'var(--mqtt-ws)',
  };
  if (!data || data.length === 0) {
    return <div style={{fontFamily:'var(--mono)', fontSize:11, color:'var(--text-dim)', padding:'6px 0'}}>no traffic yet</div>;
  }
  const max = Math.max(...data.map(d => d.n), 1);
  return (
    <div>
      {data.map(d => (
        <div key={d.ip+d.proto} style={{display:'grid', gridTemplateColumns:'1fr auto', gap:'2px 8px', alignItems:'center', padding:'5px 0', borderBottom:'1px dashed var(--border-soft)'}}>
          <div style={{fontFamily:'var(--mono)', fontSize:11.5, color:'var(--text)'}}>{d.ip}</div>
          <div style={{fontFamily:'var(--mono)', fontSize:11, color:'var(--text-muted)'}}>{d.n.toLocaleString()}</div>
          <div style={{gridColumn:'1 / -1', height:3, background:'var(--bg)', borderRadius:2, overflow:'hidden'}}>
            <div style={{height:'100%', width:`${(d.n / max) * 100}%`, background: colorFor[d.proto] || 'var(--text-muted)'}}></div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- connection banner ----------
//
// Stays expanded while connecting / disconnected so the user always sees
// problems. Once the state has been "ok" (or demo) for 3 s it collapses
// to a small unobtrusive dot in the corner so it stops covering content
// below it. Click the dot to expand again, click the banner to collapse
// it sooner.
function ConnBanner({ state }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (state === 'ok' || DEMO) {
      setCollapsed(false);
      const t = setTimeout(() => setCollapsed(true), 3000);
      return () => clearTimeout(t);
    }
    setCollapsed(false);
  }, [state]);

  const cls = DEMO ? 'demo' : state === 'ok' ? 'ok'
           : state === 'err' || state === 'closed' ? 'err' : '';
  const text = DEMO ? 'demo mode · simulated traffic'
             : state === 'ok' ? '● connected to sniffer'
             : state === 'connecting' ? '○ connecting to ws://localhost:8765 …'
             : '✕ sniffer disconnected · retrying';

  if (collapsed) {
    return (
      <button
        className={"conn-pill " + cls}
        onClick={() => setCollapsed(false)}
        title={text}
      >
        <span className="conn-pill-dot"></span>
      </button>
    );
  }
  return (
    <div
      className={"conn-banner " + cls}
      onClick={() => setCollapsed(true)}
      title="click to minimise"
    >
      {text}
    </div>
  );
}

// ---------- option C inspector shell ----------
function topicForPacket(packet) {
  if (!packet) return 'factory/line1/plc1/regs/ir/30001';
  if (packet.meta?.Topic) return packet.meta.Topic;
  if (packet.proto === 'modbus') {
    const unit = packet.meta?.Unit || '1';
    const id = (packet.meta?.TxID || '0000').replace(/^0x/i, '').toLowerCase();
    return `factory/line1/plc${unit}/regs/hr/${id}`;
  }
  const left = (packet.summary || '').split('←')[0].trim();
  if (left && left.includes('/')) return left;
  return packet.type || packet.protoLabel || 'packet';
}

const RAIL_PROTOCOLS = [
  { id: 'modbus', label: 'Modbus', short: 'MODBUS' },
  { id: 'mqtt-tcp', label: 'MQTT TCP', short: 'MQTT TCP' },
  { id: 'mqtt-ws', label: 'MQTT WS', short: 'MQTT WS' },
];

function railProtocolLabel(proto) {
  return RAIL_PROTOCOLS.find(p => p.id === proto)?.short || (proto || 'PROTO').toUpperCase();
}

function shortPacketTitle(packet) {
  if (!packet) return 'waiting for packet';
  const topic = topicForPacket(packet);
  if (topic.includes('/')) return topic;
  return `${packet.protoLabel || packet.proto} / ${packet.type}`;
}

function PacketRail({ packets, selectedId, onSelect, filter, setFilter, autoscroll, setAutoscroll, capturing, duration }) {
  const scrollerRef = useRef(null);
  const shown = useMemo(() => {
    if (!filter) return packets;
    const q = filter.toLowerCase();
    return packets.filter(p =>
      p.src.toLowerCase().includes(q) ||
      p.dst.toLowerCase().includes(q) ||
      p.type.toLowerCase().includes(q) ||
      p.summary.toLowerCase().includes(q) ||
      topicForPacket(p).toLowerCase().includes(q)
    );
  }, [packets, filter]);

  useEffect(() => {
    if (!autoscroll || !scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [shown.length, autoscroll]);

  const errors = packets.filter(p => p.isError).length;
  const latest = packets[packets.length - 1];

  return (
    <aside className="packet-rail">
      <div className="rail-brand">
        <div>
          <strong><span className={"rail-dot" + (capturing ? ' on' : '')}></span>pktscope</strong>
          <span className="rail-version">v0.4</span>
        </div>
        <button className="rail-stop" title={capturing ? 'capture running' : 'capture idle'}>{capturing ? '■' : '□'}</button>
      </div>
      <div className="rail-sub">ws://localhost:8765</div>
      <div className="rail-metrics">
        <span><b>{packets.length.toLocaleString()}</b> pkts</span>
        <span><b>{errors}</b> err</span>
        <span><b>{latest ? Math.round(latest.latency || 0) : 0}</b>ms</span>
      </div>
      <div className="rail-protocol-key" aria-label="Protocol color legend">
        {RAIL_PROTOCOLS.map(proto => (
          <span key={proto.id} className={"rail-protocol-key-item " + proto.id}>
            <span className="rail-protocol-swatch"></span>
            <span>{proto.label}</span>
          </span>
        ))}
      </div>
      <div className="rail-filter">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="filter..."
        />
        <button className={autoscroll ? 'on' : ''} onClick={() => setAutoscroll(v => !v)} title="Auto-scroll">||</button>
      </div>
      <div className="rail-list" ref={scrollerRef}>
        {shown.length === 0 && (
          <div className="rail-empty">
            <b>No packets</b>
            <span>{capturing ? 'waiting for frames' : 'capture paused'}</span>
          </div>
        )}
        {shown.map((p) => {
          const topic = topicForPacket(p);
          const topicParts = topic.split('/');
          const compactTopic = topicParts.length > 3 ? topicParts.slice(-3).join('/') : topic;
          return (
            <button
              key={p.id}
              className={"rail-packet " + p.proto + (p.isError ? ' err' : '') + (p.id === selectedId ? ' selected' : '')}
              onClick={() => onSelect(p.id)}
            >
              <span className="rail-packet-line">
                <span className="rail-caret">{p.isError ? 'x' : '>'}</span>
                <span>{fmtTime(p.ts).slice(0, 12)}</span>
                <span className="rail-proto-label">{railProtocolLabel(p.proto)}</span>
                <span className="rail-packet-type">{p.type}</span>
                <em>{p.latency ? `${Math.round(p.latency)}ms` : '-'}</em>
              </span>
              <span className="rail-topic">{compactTopic}</span>
              <span className="rail-summary">{p.summary}</span>
            </button>
          );
        })}
      </div>
      <div className="rail-foot">uptime {fmtDuration(duration)}</div>
    </aside>
  );
}

function PacketInspector({ packet }) {
  const [showAscii, setShowAscii] = useState(true);
  if (!packet) {
    return (
      <div className="inspector-empty">
        <b>Waiting for packet data</b>
        <span>Live frames will populate the packet inspector.</span>
      </div>
    );
  }

  const bytes = packet.bytes || [];
  const fields = packet.fieldMap || [];
  const fixed = fields.slice(0, Math.min(5, fields.length));
  const variable = fields.slice(Math.min(5, fields.length), Math.min(10, fields.length));
  const payloadField = fields.find(f => f.name === 'Payload' || f.name === 'Register Values');
  const packetNo = packet.meta?.TxID || packet.meta?.PktID || String(packet.id).slice(0, 6);
  const topic = topicForPacket(packet);
  const qos = packet.meta?.QoS ?? (packet.type === 'PUBLISH' ? 1 : 0);
  const word = bytes.length >= 2 ? ((bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1]) : 0;
  const signed = word > 0x7FFF ? word - 0x10000 : word;
  const scaled = Math.round((word % 2400) + 100);
  const bitValue = bytes.length >= 2 ? ((bytes[0] << 8) | bytes[1]) : word;

  return (
    <div className="packet-inspector">
      <div className="packet-head">
        <div>
          <div className="packet-kicker">packet #{packetNo}</div>
          <h1>{shortPacketTitle(packet)}</h1>
          <div className="packet-meta">
            <span>{fmtTime(packet.ts)}</span>
            <span>{fmtBytes(bytes.length)} on wire</span>
            <span>{packet.latency ? `${packet.latency.toFixed(1)}ms rtt` : 'latency pending'}</span>
          </div>
        </div>
        <div className="packet-badges">
          <span className="badge rx">RX</span>
          <span className="badge">{packet.type}</span>
          <span className="badge">QoS {qos}</span>
        </div>
      </div>

      <div className="packet-panels two">
        <FramePanel title="fixed header" fields={fixed} fallback={[
          ['packet_type', `${packet.type} (${packet.protoLabel})`],
          ['dup_flag', '0'],
          ['qos', String(qos)],
          ['retain', '0'],
          ['remaining_length', `${bytes.length} bytes`],
        ]}/>
        <FramePanel title="variable header" fields={variable} fallback={[
          ['topic_name', topic],
          ['topic_length', `${topic.length} bytes`],
          ['packet_id', String(packetNo)],
          ['source', packet.src],
          ['destination', packet.dst],
        ]}/>
      </div>

      <section className="packet-section payload">
        <div className="section-title">payload - {payloadField ? payloadField.desc : `${bytes.length} bytes`}</div>
        <div className="payload-grid">
          <div>
            <div className="sub-label">hex dump</div>
            <div className="hex-strip">
              <span>0000</span>
              {(bytes.slice(0, 18).length ? bytes.slice(0, 18) : [0, 0]).map((b, i) => (
                <b key={i}>{hex(b)}</b>
              ))}
              {bytes.length > 18 && <em>..</em>}
            </div>
          </div>
          <div>
            <div className="sub-label">bit map - 16-bit reg</div>
            <div className="bit-grid">
              {Array.from({ length: 16 }, (_, i) => {
                const bit = 15 - i;
                const on = ((bitValue >> bit) & 1) === 1;
                return (
                  <span className={on ? 'on' : ''} key={bit}>
                    <b>{on ? 1 : 0}</b>
                    <em>{bit}</em>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
        <div className="decode-strip">
          <ValueBox label="u16" value={word}/>
          <ValueBox label="i16" value={signed}/>
          <ValueBox label="hex" value={`0x${hex(word, 4)}`}/>
          <ValueBox label="scaled" value={`${scaled} rpm`}/>
        </div>
        {showAscii && payloadField && (
          <pre className="payload-ascii">{String(payloadField.value || packet.summary)}</pre>
        )}
      </section>

      <section className="packet-section workbench">
        <details open>
          <summary>publish workbench</summary>
          <div className="workbench-grid">
            <label>
              <span>topic</span>
              <input value={topic.replace('/regs/', '/cmd/')} readOnly />
            </label>
            <label>
              <span>payload (hex bytes)</span>
              <textarea readOnly value={bytes.slice(0, 12).map(b => hex(b)).join(' ') || '01 06 9C 41 01 F4'} />
            </label>
            <div className="template-grid">
              <Template label="read holding" bytes="01 03 9C 40 00 01"/>
              <Template label="read input" bytes="01 04 75 30 00 01"/>
              <Template label="write single" bytes="01 06 9C 41 01 F4"/>
              <Template label="write multi" bytes="01 10 9C 41 00 02 04 01 F4 03 E8"/>
            </div>
            <div className="workbench-actions">
              <select defaultValue="1"><option value="0">qos 0</option><option value="1">qos 1</option><option value="2">qos 2</option></select>
              <label className="check"><input type="checkbox" readOnly /> retain</label>
              <label className="check"><input type="checkbox" checked readOnly /> hex mode</label>
              <button>save preset</button>
              <button className="publish">publish</button>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}

function FramePanel({ title, fields, fallback }) {
  const rows = fields.length ? fields.map(f => [f.name.replace(/\s+/g, '_').toLowerCase(), f.value]) : fallback;
  return (
    <section className="packet-section">
      <div className="section-title">{title}</div>
      <dl className="frame-fields">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

function ValueBox({ label, value }) {
  return (
    <div className="value-box">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Template({ label, bytes }) {
  return (
    <button className="template">
      <b>{label}</b>
      <span>{bytes}</span>
    </button>
  );
}

function InspectorRail({ packets, series, latency, errorHist, connStatus, ports, duration, topTalkers }) {
  const topics = useMemo(() => buildTopicTree(packets), [packets]);
  const last = series[series.length - 1] || { bytes: 0, msgs: 0 };
  return (
    <aside className="topic-rail">
      <RailSection title="topic tree" note={`${packets.length} active`}>
        <TopicTree nodes={topics}/>
      </RailSection>
      <RailSection title="signal">
        <div className="rail-chart-label">latency - 60 samples</div>
        <MiniSpark data={series.map(s => s.msgs)} />
        <div className="rail-chart-label">packet loss - 30 samples</div>
        <div className="loss-bars">
          {errorHist.concat(errorHist).slice(-30).map((h, i) => (
            <span key={i} className={h > 0.6 ? 'hot' : ''}></span>
          ))}
        </div>
      </RailSection>
      <RailSection title="connection">
        <div className="conn-form">
          <label><span>host</span><input value="nodered.local" readOnly /></label>
          <label><span>port</span><input value={ports['mqtt-tcp']} readOnly /></label>
          <label><span>path</span><input value="/mqtt" readOnly /></label>
          <label><span>client</span><input value="pktscope-c4" readOnly /></label>
          <label><span>user</span><input value="ops" readOnly /></label>
          <label><span>pass</span><input value="••••••" readOnly /></label>
          <div className="conn-checks">
            <label><input type="checkbox" checked readOnly /> clean</label>
            <label><input type="checkbox" readOnly /> tls</label>
          </div>
          <div className="conn-uptime">uptime: <b>{fmtDuration(duration)}</b></div>
        </div>
      </RailSection>
      <RailSection title="top talkers" note={`${fmtBytes(last.bytes)}/s`}>
        <TopTalkers data={topTalkers}/>
      </RailSection>
    </aside>
  );
}

function RailSection({ title, note, children }) {
  return (
    <section className="rail-section">
      <div className="rail-section-title">
        <span>{title}</span>
        {note && <em>{note}</em>}
      </div>
      {children}
    </section>
  );
}

function buildTopicTree(packets) {
  const root = {};
  for (const p of packets) {
    const parts = topicForPacket(p).split('/').filter(Boolean);
    let cursor = root;
    for (const part of parts.slice(0, 5)) {
      if (!cursor[part]) cursor[part] = { _count: 0, _children: {} };
      cursor[part]._count += 1;
      cursor = cursor[part]._children;
    }
  }
  return root;
}

function TopicTree({ nodes, level = 0 }) {
  const entries = Object.entries(nodes).slice(0, level === 0 ? 5 : 6);
  if (!entries.length) return <div className="topic-empty">no topics yet</div>;
  return (
    <ul className={"topic-tree level-" + level}>
      {entries.map(([name, node]) => (
        <li key={name}>
          <div>
            <span>{level === 0 ? '▸' : '·'} {name}</span>
            <em>{node._count}</em>
          </div>
          {level < 3 && Object.keys(node._children).length > 0 && (
            <TopicTree nodes={node._children} level={level + 1}/>
          )}
        </li>
      ))}
    </ul>
  );
}

function MiniSpark({ data }) {
  const W = 240, H = 48;
  const max = Math.max(1, ...data);
  const points = data.map((v, i) => {
    const x = (i / Math.max(1, data.length - 1)) * W;
    const y = H - (v / max) * (H - 5) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="mini-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  );
}

// ---------- app ----------
function App() {
  const [theme, setTheme] = useState(() => {
    const requestedTheme = QS.get('theme');
    if (requestedTheme === 'dark' || requestedTheme === 'light') return requestedTheme;
    try {
      return localStorage.getItem('iot-sniffer-theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [iface, setIface] = useState('eth0');
  const [capturing, setCapturing] = useState(true);
  const [enabledProtos, setEnabledProtos] = useState(new Set(['modbus','mqtt-tcp','mqtt-ws']));
  const [ports, setPorts] = useState({ modbus: '502', 'mqtt-tcp': '1883', 'mqtt-ws': '8083' });

  const [packets, setPackets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [activeTab, setActiveTab] = useState(INITIAL_TAB);

  const [duration, setDuration] = useState(0);
  const [series, setSeries] = useState(() => Array.from({length: 60}, () => ({ bytes: 0, msgs: 0 })));
  const [latencyDist, setLatencyDist] = useState({ p50: 0, p95: 0, p99: 0 });
  const [mqttReconnects, setMqttReconnects] = useState(0);
  const [modbusExceptions, setModbusExceptions] = useState(0);
  const [errorHist, setErrorHist] = useState(() => Array.from({length: 24}, () => 0));
  const [connState, setConnState] = useState(DEMO ? 'ok' : 'connecting');
  const [perfData, setPerfData] = useState(null);
  const liveConnRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('iot-sniffer-theme', theme);
    } catch {}
  }, [theme]);

  const toggleProto = (id) => setEnabledProtos(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const setPort = (k, v) => setPorts(prev => ({ ...prev, [k]: v }));

  const appendPacket = useCallback((pkt) => {
    if (!pkt) return;
    if (!enabledProtos.has(pkt.proto)) return;
    setPackets(prev => {
      const next = [...prev, pkt];
      if (next.length > MAX_PACKETS) next.splice(0, next.length - MAX_PACKETS);
      return next;
    });
  }, [enabledProtos]);

  // --- live wire ---
  useEffect(() => {
    if (DEMO) return;
    const conn = new window.Live.LiveConnection();
    liveConnRef.current = conn;
    const offS = conn.on('state', setConnState);
    const offF = conn.on('frame', (pkt) => {
      if (!capturingRef.current) return;
      // In live mode we accept all; protocol filter is applied in the renderer via enabled set.
      appendPacketRef.current(pkt);
    });
    const offM = conn.on('metrics', (m) => {
      setDuration(Math.round(m.duration_s || 0));
      setSeries(prev => [...prev.slice(1), { bytes: m.throughput_bps || 0, msgs: m.throughput_mps || 0 }]);
      setLatencyDist({ p50: m.p50_ms || 0, p95: m.p95_ms || 0, p99: m.p99_ms || 0 });
      setMqttReconnects(m.reconnect_count || 0);
      setModbusExceptions(m.modbus_exceptions || 0);
      setErrorHist(prev => [...prev.slice(1), m.error_rate || 0]);
    });
    const offP = conn.on('perf', (p) => setPerfData(p));
    return () => { offS(); offF(); offM(); offP(); conn.disconnect(); liveConnRef.current = null; };
  }, []);

  // --- demo mode fallback (?demo=1) ---
  useEffect(() => {
    if (!DEMO) return;
    if (!capturing) return;
    const int = setInterval(() => {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const p = window.Sim.synthPacket(enabledProtos);
        if (!p) continue;
        const now = Date.now();
        appendPacket({ ...p, id: now + i + Math.random(), ts: now });
      }
    }, 600);
    return () => clearInterval(int);
  }, [capturing, enabledProtos, appendPacket]);

  useEffect(() => {
    if (!DEMO) return;
    if (!capturing) return;
    const int = setInterval(() => {
      setSeries(prev => {
        const last = prev[prev.length - 1];
        return [...prev.slice(1), {
          bytes: Math.max(50, (last?.bytes ?? 600) + (Math.random() - 0.5) * 380),
          msgs: Math.max(1, (last?.msgs ?? 14) + (Math.random() - 0.5) * 6),
        }];
      });
      setDuration(d => d + 1);
      if (Math.random() < 0.08) setModbusExceptions(n => n + 1);
      if (Math.random() < 0.02) setMqttReconnects(n => n + 1);
      setErrorHist(prev => [...prev.slice(1), Math.random() * (Math.random() < 0.15 ? 1.6 : 0.5)]);
    }, 1000);
    return () => clearInterval(int);
  }, [capturing]);

  // --- refs so the long-lived WS callbacks pick up latest values ---
  const capturingRef = useRef(capturing);
  capturingRef.current = capturing;
  const appendPacketRef = useRef(appendPacket);
  appendPacketRef.current = appendPacket;

  // --- derived ---
  const selected = packets.find(p => p.id === selectedId) || packets[packets.length - 1] || null;
  const protoCounts = useMemo(() => {
    const c = { modbus: 0, 'mqtt-tcp': 0, 'mqtt-ws': 0 };
    packets.forEach(p => { c[p.proto] = (c[p.proto] || 0) + 1; });
    return c;
  }, [packets]);

  const totalBytes = useMemo(
    () => packets.reduce((s, p) => s + (p.bytes?.length || 0), 0),
    [packets]
  );

  // Demo mode: compute latency from UI packets. Live mode: trust backend snapshot.
  const latency = DEMO ? useMemo(() => {
    const lats = packets.map(p => p.latency || 0).sort((a,b) => a-b);
    if (lats.length === 0) return { p50: 0, p95: 0, p99: 0 };
    const pick = (pct) => lats[Math.min(lats.length - 1, Math.floor(lats.length * pct))];
    return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
  }, [packets]) : latencyDist;

  const errorRate = useMemo(
    () => packets.filter(p => p.isError).length,
    [packets]
  );

  const topTalkers = useMemo(() => {
    const byKey = new Map();
    for (const p of packets) {
      const ip = p.src.split(':')[0];
      const key = `${ip}|${p.proto}`;
      const rec = byKey.get(key) || { ip, proto: p.proto, n: 0 };
      rec.n++;
      byKey.set(key, rec);
    }
    return [...byKey.values()].sort((a, b) => b.n - a.n).slice(0, 5);
  }, [packets]);

  const connStatus = {
    modbus: !capturing ? 'idle' : enabledProtos.has('modbus') ? 'ok' : 'idle',
    'mqtt-tcp': !capturing ? 'idle' : enabledProtos.has('mqtt-tcp') ? 'ok' : 'idle',
    'mqtt-ws': !capturing ? 'idle' : enabledProtos.has('mqtt-ws') ? (connState === 'ok' ? 'ok' : 'err') : 'idle',
  };

  const onClear = () => { setPackets([]); setSelectedId(null); };

  return (
    <div className="app inspector-shell">
      <TopBar
        capturing={capturing}
        onClear={onClear}
        duration={duration}
        totalBytes={totalBytes}
        totalPackets={packets.length}
        theme={theme}
        onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
      />
      <div className="main inspector-main">
        <PacketRail
          packets={packets}
          selectedId={selected?.id}
          onSelect={setSelectedId}
          filter={filter}
          setFilter={setFilter}
          autoscroll={autoscroll}
          setAutoscroll={setAutoscroll}
          capturing={capturing}
          duration={duration}
        />
        <div className="center inspector-center">
          <div className="tabs">
            <div
              className={"tab" + (activeTab === 'stream' ? ' active' : '')}
              onClick={() => setActiveTab('stream')}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
                <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round"/>
              </svg>
              Packet inspector
              <span className="badge">{packets.length.toLocaleString()}</span>
            </div>
            <div
              className={"tab" + (activeTab === 'graph' ? ' active' : '')}
              onClick={() => setActiveTab('graph')}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
                <circle cx="3" cy="8" r="1.6"/>
                <circle cx="13" cy="4" r="1.6"/>
                <circle cx="13" cy="12" r="1.6"/>
                <path d="M4.3 7.3l7.4-2.8M4.3 8.7l7.4 2.8" strokeLinecap="round"/>
              </svg>
              Connection graph
            </div>
            <div
              className={"tab" + (activeTab === 'perf' ? ' active' : '')}
              onClick={() => setActiveTab('perf')}
              title="Detailed latency / throughput / per-flow analysis for scientific use"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
                <path d="M2 13L6 8L9 11L14 4" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 13h12" strokeLinecap="round"/>
              </svg>
              Performance
            </div>
            <div className="tab-spacer"></div>
          </div>

          {activeTab === 'stream' ? (
            <PacketInspector packet={selected}/>
          ) : activeTab === 'graph' ? (
            (() => { const G = window.ConnectionGraph; return <G packets={packets}/>; })()
          ) : (
            (() => {
              const P = window.PerformanceTab;
              return <P perf={perfData} packets={packets} conn={liveConnRef.current}
                        demo={DEMO} metricsSeries={series}/>;
            })()
          )}
        </div>
        <InspectorRail
          packets={packets}
          series={series}
          latency={latency}
          errorHist={errorHist}
          connStatus={connStatus}
          ports={ports}
          duration={duration}
          topTalkers={topTalkers}
        />
      </div>
      <ConnBanner state={connState}/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
