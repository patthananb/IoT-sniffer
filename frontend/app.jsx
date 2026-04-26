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

function snifferUrlLabel() {
  if (DEMO) return 'demo mode';
  const raw = window.Live?.DEFAULT_URL || 'ws://localhost:8765';
  try {
    const url = new URL(raw, location.href);
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.split('?')[0];
  }
}

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
          <div className="stat-label">Stream</div>
          <div className={"stat-value" + (capturing ? " live" : "")}>
            {capturing ? '● LIVE' : '○ PAUSED'}
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
      </div>
    </div>
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
             : state === 'connecting' ? `○ connecting to ${snifferUrlLabel()} ...`
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

function topicForPacket(packet) {
  if (!packet) return '';
  if (packet.meta?.Topic) return String(packet.meta.Topic);
  if (!String(packet.proto || '').startsWith('mqtt')) return '';
  const left = (packet.summary || '').split('←')[0].trim();
  if (left && left.includes('/')) return left;
  return '';
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
  if (topic) return topic;
  return `${packet.protoLabel || packet.proto} / ${packet.type || 'packet'}`;
}

function PacketRail({ packets, selectedId, onSelect, filter, setFilter, autoscroll, setAutoscroll, capturing, onToggleCapture, duration }) {
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
        <button
          className="rail-stop"
          onClick={onToggleCapture}
          title={capturing ? 'Pause stream intake' : 'Resume stream intake'}
        >
          {capturing ? 'pause' : 'resume'}
        </button>
      </div>
      <div className="rail-sub">{snifferUrlLabel()}</div>
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
          const compactTopic = topic
            ? topicParts.length > 3 ? topicParts.slice(-3).join('/') : topic
            : `${p.protoLabel || p.proto} / ${p.type || 'packet'}`;
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
  const registerField = fields.find(f => f.name === 'Register Values');
  const registerBytes = registerField
    ? (registerField.bytes || []).map(i => bytes[i]).filter(b => b !== undefined)
    : [];
  const packetNo = packet.meta?.TxID || packet.meta?.PktID || String(packet.id).slice(0, 6);
  const topic = topicForPacket(packet);
  const isMqtt = String(packet.proto || '').startsWith('mqtt');
  const qos = packet.meta?.QoS;
  const showQos = isMqtt && packet.type === 'PUBLISH' && qos != null;
  const registerWord = registerBytes.length >= 2 ? ((registerBytes[0] << 8) | registerBytes[1]) : null;
  const registerSigned = registerWord != null && registerWord > 0x7FFF ? registerWord - 0x10000 : registerWord;

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
          <span className="badge">{packet.protoLabel || packet.proto}</span>
          <span className="badge">{packet.type}</span>
          {showQos && <span className="badge">QoS {qos}</span>}
        </div>
      </div>

      <div className="packet-panels two">
        <FramePanel title="fixed header" fields={fixed} fallback={[
          ['packet_type', `${packet.type} (${packet.protoLabel || packet.proto})`],
          ['source', packet.src],
          ['destination', packet.dst],
          ['wire_length', `${bytes.length} bytes`],
        ]}/>
        <FramePanel title="variable header" fields={variable} fallback={[
          ...(topic ? [['topic_name', topic], ['topic_length', `${topic.length} bytes`]] : []),
          ['correlation_id', String(packetNo)],
          ['source', packet.src],
          ['destination', packet.dst],
        ]}/>
      </div>

      <section className="packet-section payload">
        <div className="section-title">payload - {payloadField ? payloadField.desc : `${bytes.length} bytes`}</div>
        <div className={"payload-grid" + (registerWord == null ? " single" : "")}>
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
          {registerWord != null && (
            <div>
              <div className="sub-label">first register bits</div>
              <div className="bit-grid">
                {Array.from({ length: 16 }, (_, i) => {
                  const bit = 15 - i;
                  const on = ((registerWord >> bit) & 1) === 1;
                  return (
                    <span className={on ? 'on' : ''} key={bit}>
                      <b>{on ? 1 : 0}</b>
                      <em>{bit}</em>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        {registerWord != null && (
          <div className="decode-strip three">
            <ValueBox label="u16" value={registerWord}/>
            <ValueBox label="i16" value={registerSigned}/>
            <ValueBox label="hex" value={`0x${hex(registerWord, 4)}`}/>
          </div>
        )}
        {payloadField && (
          <pre className="payload-ascii">{String(payloadField.value || packet.summary)}</pre>
        )}
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

function InspectorRail({ packets, series, errorHist, topTalkers }) {
  const topicInfo = useMemo(() => buildTopicTree(packets), [packets]);
  const last = series[series.length - 1] || { bytes: 0, msgs: 0 };
  return (
    <aside className="topic-rail">
      <RailSection title="mqtt topics" note={`${topicInfo.count} topics`}>
        <TopicTree nodes={topicInfo.nodes}/>
      </RailSection>
      <RailSection title="signal">
        <div className="rail-chart-label">throughput - 60 samples</div>
        <MiniSpark data={series.map(s => s.msgs)} />
        <div className="rail-chart-label">packet loss - 30 samples</div>
        <div className="loss-bars">
          {errorHist.concat(errorHist).slice(-30).map((h, i) => (
            <span key={i} className={h > 0.6 ? 'hot' : ''}></span>
          ))}
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
  const uniqueTopics = new Set();
  for (const p of packets) {
    const topic = topicForPacket(p);
    if (!topic) continue;
    uniqueTopics.add(topic);
    const parts = topic.split('/').filter(Boolean);
    let cursor = root;
    for (const part of parts) {
      if (!cursor[part]) cursor[part] = { _count: 0, _children: {} };
      cursor[part]._count += 1;
      cursor = cursor[part]._children;
    }
  }
  return { nodes: root, count: uniqueTopics.size };
}

function TopicTree({ nodes, level = 0 }) {
  const entries = Object.entries(nodes).sort((a, b) => b[1]._count - a[1]._count || a[0].localeCompare(b[0]));
  if (!entries.length) return <div className="topic-empty">no topics yet</div>;
  return (
    <ul className={"topic-tree level-" + level}>
      {entries.map(([name, node]) => (
        <li key={name}>
          <div>
            <span>{level === 0 ? '▸' : '·'} {name}</span>
            <em>{node._count}</em>
          </div>
          {Object.keys(node._children).length > 0 && (
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
  const [capturing, setCapturing] = useState(true);
  const enabledProtos = useMemo(() => new Set(['modbus','mqtt-tcp','mqtt-ws']), []);

  const [packets, setPackets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [activeTab, setActiveTab] = useState(INITIAL_TAB);

  const [duration, setDuration] = useState(0);
  const [series, setSeries] = useState(() => Array.from({length: 60}, () => ({ bytes: 0, msgs: 0 })));
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
  const totalBytes = useMemo(
    () => packets.reduce((s, p) => s + (p.bytes?.length || 0), 0),
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
          onToggleCapture={() => setCapturing(v => !v)}
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
            (() => { const G = window.ConnectionGraph; return <G packets={packets} demo={DEMO}/>; })()
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
          errorHist={errorHist}
          topTalkers={topTalkers}
        />
      </div>
      <ConnBanner state={connState}/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
