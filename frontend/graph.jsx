// Connection graph — three view modes:
//   'sequence' — UML-style sequence diagram
//   'topology' — devices by role with protocol edges
//   'matrix'   — circular graph + adjacency matrix
//
// Demo mode can show a named device list that matches the synthesizer's IP
// range. Live captures start from observed packet endpoints instead, inferring
// role from the port that's in the flow (502 -> PLC, 1883 -> broker,
// 8083 -> gateway, fallback -> edge).

const { useState: useStateG, useMemo: useMemoG, useRef: useRefG, useEffect: useEffectG } = React;

// --- user-editable host labels (localStorage) ---
// Overrides are keyed by IP: { "10.0.14.12": { label, role, detail } }.
// Any subset of those fields may be set. Unset fields fall back to discovered
// values, or demo presets when demo mode is active.
const HOST_LABELS_KEY = 'iot-sniffer.hostLabels.v1';
function loadHostLabels() {
  try {
    const v = JSON.parse(localStorage.getItem(HOST_LABELS_KEY) || '{}');
    return (v && typeof v === 'object') ? v : {};
  } catch { return {}; }
}
function saveHostLabels(obj) {
  try { localStorage.setItem(HOST_LABELS_KEY, JSON.stringify(obj)); } catch {}
}

// Role options drive both the edit UI and the topology lane assignment.
const ROLE_OPTIONS = [
  { id: 'plc',     label: 'PLC',     group: 'plcs' },
  { id: 'hmi',     label: 'HMI',     group: 'control' },
  { id: 'scada',   label: 'SCADA',   group: 'control' },
  { id: 'broker',  label: 'Broker',  group: 'brokers' },
  { id: 'gateway', label: 'Gateway', group: 'brokers' },
  { id: 'edge',    label: 'Edge',    group: 'edge' },
  { id: 'sensor',  label: 'Sensor',  group: 'sensors' },
];
const groupForRole = (role) => ROLE_OPTIONS.find(r => r.id === role)?.group || 'edge';

const PRESET_DEVICES = [
  { ip: '10.0.2.10',  label: 'SCADA',      role: 'scada',   group: 'control', detail: 'Ignition' },
  { ip: '10.0.8.4',   label: 'HMI-01',     role: 'hmi',     group: 'control', detail: 'WinCC' },
  { ip: '10.0.8.5',   label: 'HMI-02',     role: 'hmi',     group: 'control', detail: 'WinCC' },
  { ip: '10.0.14.12', label: 'PLC-A01',    role: 'plc',     group: 'plcs',    detail: 'S7-1500' },
  { ip: '10.0.14.18', label: 'PLC-A02',    role: 'plc',     group: 'plcs',    detail: 'S7-1500' },
  { ip: '10.0.14.23', label: 'PLC-B01',    role: 'plc',     group: 'plcs',    detail: 'CompactLogix' },
  { ip: '10.0.14.31', label: 'PLC-B02',    role: 'plc',     group: 'plcs',    detail: 'M580' },
  { ip: '10.0.4.20',  label: 'broker-01',  role: 'broker',  group: 'brokers', detail: 'EMQX' },
  { ip: '10.0.4.21',  label: 'ws-gw',      role: 'gateway', group: 'brokers', detail: 'WS bridge' },
  { ip: '172.19.3.7', label: 'edge-A',     role: 'edge',    group: 'edge',    detail: 'bridge' },
  { ip: '172.19.3.9', label: 'edge-B',     role: 'edge',    group: 'edge',    detail: 'bridge' },
  { ip: '192.168.40.112', label: 'sensor-112', role: 'sensor', group: 'sensors', detail: 'temp+vib' },
  { ip: '192.168.40.118', label: 'sensor-118', role: 'sensor', group: 'sensors', detail: 'flow' },
  { ip: '192.168.40.125', label: 'sensor-125', role: 'sensor', group: 'sensors', detail: 'pressure' },
  { ip: '192.168.40.134', label: 'sensor-134', role: 'sensor', group: 'sensors', detail: 'level' },
  { ip: '192.168.40.141', label: 'sensor-141', role: 'sensor', group: 'sensors', detail: 'vibration' },
];

const GROUPS = [
  { id: 'plcs',     title: 'PLCs / field',    x: 0.12 },
  { id: 'control',  title: 'Control room',    x: 0.32 },
  { id: 'brokers',  title: 'Brokers',         x: 0.55 },
  { id: 'edge',     title: 'Edge bridges',    x: 0.75 },
  { id: 'sensors',  title: 'Sensors',         x: 0.92 },
];

const PROTO_COLOR = {
  modbus:     'oklch(0.74 0.12 195)',
  'mqtt-tcp': 'oklch(0.80 0.14 75)',
  'mqtt-ws':  'oklch(0.74 0.14 25)',
};
const PROTO_LABEL = {
  modbus: 'Modbus',
  'mqtt-tcp': 'MQTT/TCP',
  'mqtt-ws': 'MQTT/WS',
};
const PROTO_OFFSET = {
  modbus: -16,
  'mqtt-tcp': 0,
  'mqtt-ws': 16,
};

const ipOf = (ep) => (ep || '').split(':')[0];
const portOf = (ep) => parseInt((ep || '').split(':')[1] || '0', 10);

function inferRole(port) {
  if (port === 502) return { role: 'plc', group: 'plcs', detail: 'auto' };
  if (port === 1883) return { role: 'broker', group: 'brokers', detail: 'auto' };
  if (port === 8083) return { role: 'gateway', group: 'brokers', detail: 'auto' };
  return { role: 'edge', group: 'edge', detail: 'auto' };
}

function labelFromIp(ip) {
  const last = ip.split('.').pop() || ip;
  return `host-${last}`;
}

// Build a fresh device map from a packet list: start with demo presets when
// requested, then synthesise records for any IP we see, then apply
// user overrides (from localStorage) last so they always win.
function buildDeviceMap(packets, overrides = {}, includePresets = false) {
  const map = new Map();
  if (includePresets) PRESET_DEVICES.forEach(d => map.set(d.ip, d));
  const portsByIp = new Map();
  for (const p of packets) {
    const sIp = ipOf(p.src), dIp = ipOf(p.dst);
    const dPort = portOf(p.dst);
    if (!portsByIp.has(sIp)) portsByIp.set(sIp, new Set());
    if (!portsByIp.has(dIp)) portsByIp.set(dIp, new Set());
    portsByIp.get(sIp).add(dPort);
    portsByIp.get(dIp).add(dPort);
  }
  portsByIp.forEach((ports, ip) => {
    if (map.has(ip)) return;
    const guess = inferRole([...ports].find(pt => pt === 502 || pt === 1883 || pt === 8083) || 0);
    map.set(ip, { ip, label: labelFromIp(ip), ...guess });
  });
  // Overrides may target IPs we haven't seen in traffic yet — still honour them
  // so a user can pre-label a device before it shows up.
  const allIps = new Set([...map.keys(), ...Object.keys(overrides || {})]);
  allIps.forEach(ip => {
    const base = map.get(ip) || { ip, label: labelFromIp(ip), role: 'edge', group: 'edge', detail: '' };
    const ov = (overrides || {})[ip];
    if (!ov) { map.set(ip, base); return; }
    const role = ov.role || base.role;
    map.set(ip, {
      ...base,
      label: ov.label || base.label,
      role,
      group: groupForRole(role),
      detail: ov.detail != null ? ov.detail : base.detail,
    });
  });
  return map;
}

// Keep known and discovered devices in a stable list for the views.
function devicesFromMap(devMap, includePresets = false) {
  const entries = [...devMap.values()];
  if (!includePresets) return entries.sort((a, b) => a.ip.localeCompare(b.ip));

  // Preserve demo preset order first, then append any auto-discovered in IP order.
  const preset = PRESET_DEVICES.map(d => devMap.get(d.ip)).filter(Boolean);
  const extras = entries.filter(d => !PRESET_DEVICES.find(x => x.ip === d.ip));
  extras.sort((a, b) => a.ip.localeCompare(b.ip));
  return [...preset, ...extras];
}

function buildStats(packets, showProtos, devMap) {
  const edges = new Map();
  const pairMat = new Map();
  const nodeStats = new Map();
  devMap.forEach((d, ip) => nodeStats.set(ip, { sent: 0, recv: 0, bytes: 0, errors: 0, protos: new Set() }));
  for (const p of packets) {
    if (!showProtos.has(p.proto)) continue;
    const sIp = ipOf(p.src); const dIp = ipOf(p.dst);
    if (!devMap.has(sIp) || !devMap.has(dIp)) continue;
    const ek = `${sIp}|${dIp}|${p.proto}`;
    if (!edges.has(ek)) edges.set(ek, { src: sIp, dst: dIp, proto: p.proto, count: 0, bytes: 0, errors: 0 });
    const e = edges.get(ek); e.count++; e.bytes += (p.bytes?.length || 0); if (p.isError) e.errors++;
    const pk = `${sIp}|${dIp}`;
    if (!pairMat.has(pk)) pairMat.set(pk, { count: 0, bytes: 0, errors: 0, protos: new Set() });
    const m = pairMat.get(pk); m.count++; m.bytes += (p.bytes?.length || 0); m.protos.add(p.proto); if (p.isError) m.errors++;
    const s = nodeStats.get(sIp); s.sent++; s.bytes += (p.bytes?.length || 0); s.protos.add(p.proto); if (p.isError) s.errors++;
    const d = nodeStats.get(dIp); d.recv++; d.bytes += (p.bytes?.length || 0); d.protos.add(p.proto); if (p.isError) d.errors++;
  }
  return { edges: Array.from(edges.values()), pairMat, nodeStats };
}

function topologyPath(s, d, proto, laneOffset = 0) {
  const dir = d.x >= s.x ? 1 : -1;
  const dx = Math.abs(d.x - s.x);
  const offset = (PROTO_OFFSET[proto] || 0) + laneOffset;
  const bend = Math.max(42, Math.min(120, dx * 0.28));
  const y1 = s.y + offset;
  const y2 = d.y + offset;
  return `M${s.x} ${s.y} C${s.x + dir * bend} ${y1} ${d.x - dir * bend} ${y2} ${d.x} ${d.y}`;
}

// ---------- SEQUENCE ----------
function SequenceView({ packets, showProtos, devMap, includePresets = false }) {
  const wrapRef = useRefG(null);
  const scrollRef = useRefG(null);
  const [wrapSize, setWrapSize] = useStateG({ w: 900, h: 600 });
  const [hoverMsg, setHoverMsg] = useStateG(null);
  const [autoscroll, setAutoscroll] = useStateG(true);

  useEffectG(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const r = e.contentRect;
        setWrapSize({ w: Math.max(520, r.width), h: Math.max(300, r.height) });
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const devices = useMemoG(() => devicesFromMap(devMap, includePresets), [devMap, includePresets]);

  const activeDevices = useMemoG(() => {
    const seen = new Set();
    for (const p of packets) {
      if (!showProtos.has(p.proto)) continue;
      seen.add(ipOf(p.src)); seen.add(ipOf(p.dst));
    }
    return devices.filter(d => seen.has(d.ip));
  }, [packets, showProtos, devices]);

  const messages = useMemoG(() => {
    const list = [];
    for (const p of packets) {
      if (!showProtos.has(p.proto)) continue;
      const sIp = ipOf(p.src); const dIp = ipOf(p.dst);
      if (!devMap.has(sIp) || !devMap.has(dIp)) continue;
      list.push({ id: p.id, ts: p.ts, src: sIp, dst: dIp,
        proto: p.proto, type: p.type, summary: p.summary,
        isError: p.isError, latency: p.latency || 0, bytes: (p.bytes?.length || 0) });
    }
    return list.slice(-120);
  }, [packets, showProtos, devMap]);

  const HEADER_H = 64, TIME_PAD_TOP = 12, ROW_H = 28, LEFT_PAD = 60, RIGHT_PAD = 20, BOTTOM_PAD = 40;
  const colCount = Math.max(1, activeDevices.length);
  const svgW = Math.max(wrapSize.w, LEFT_PAD + RIGHT_PAD + colCount * 120);
  const columnSpan = svgW - LEFT_PAD - RIGHT_PAD;
  const colX = (i) => LEFT_PAD + (columnSpan * (i + 0.5)) / colCount;
  const colOfIp = new Map();
  activeDevices.forEach((d, i) => colOfIp.set(d.ip, i));
  const diagramH = HEADER_H + TIME_PAD_TOP + messages.length * ROW_H + BOTTOM_PAD;
  const svgH = Math.max(wrapSize.h, diagramH);

  useEffectG(() => {
    if (!autoscroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, autoscroll, svgH]);

  const now = Date.now();

  return (
    <div className="seq-inner" ref={wrapRef}>
      <label className={"autoscroll-toggle seq-follow" + (autoscroll ? " on" : "")}
             onClick={() => setAutoscroll(!autoscroll)}>
        <span className="pill"></span>follow
      </label>
      <div className="seq-header" style={{width: svgW}}>
        <svg width={svgW} height={HEADER_H} viewBox={`0 0 ${svgW} ${HEADER_H}`}>
          {activeDevices.map((d, i) => {
            const x = colX(i);
            const boxW = Math.min(112, (columnSpan / colCount) - 10);
            return (
              <g key={d.ip} transform={`translate(${x}, 0)`}>
                <rect x={-boxW/2} y={10} width={boxW} height={40} rx={3} ry={3}
                      fill="var(--bg-panel)" stroke="var(--text-muted)" strokeWidth="1.3"/>
                <text x="0" y="27" textAnchor="middle" className="seq-dev-label">{d.label}</text>
                <text x="0" y="42" textAnchor="middle" className="seq-dev-sub">{d.ip}</text>
              </g>
            );
          })}
          <text x="8" y="40" className="seq-time-label">Time ↓</text>
        </svg>
      </div>
      <div className="seq-body" ref={scrollRef}
           onScroll={(e) => {
             const el = e.currentTarget;
             const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
             if (!atBottom && autoscroll) setAutoscroll(false);
           }}>
        <svg width={svgW} height={svgH - HEADER_H}
             viewBox={`0 0 ${svgW} ${svgH - HEADER_H}`} style={{display:'block'}}>
          <defs>
            {Object.entries(PROTO_COLOR).map(([k, c]) => (
              <marker key={k} id={`seq-arr-${k}`} viewBox="0 0 10 10" refX="9" refY="5"
                      markerWidth="8" markerHeight="8" orient="auto">
                <path d="M0 0 L10 5 L0 10 z" fill={c}/>
              </marker>
            ))}
            <marker id="seq-arr-err" viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0 L10 5 L0 10 z" fill="var(--err)"/>
            </marker>
          </defs>
          {activeDevices.map((d) => {
            const i = colOfIp.get(d.ip);
            const x = colX(i);
            return <line key={d.ip} className="seq-lifeline" x1={x} x2={x} y1={0} y2={svgH - HEADER_H}/>;
          })}
          {messages.map((m, i) => {
            const sIdx = colOfIp.get(m.src); const dIdx = colOfIp.get(m.dst);
            if (sIdx == null || dIdx == null) return null;
            const x1 = colX(sIdx); const x2 = colX(dIdx);
            const y = TIME_PAD_TOP + (i + 0.5) * ROW_H;
            const color = m.isError ? 'var(--err)' : PROTO_COLOR[m.proto];
            const marker = m.isError ? 'seq-arr-err' : `seq-arr-${m.proto}`;
            const hov = hoverMsg === m.id;
            if (sIdx === dIdx) {
              const loopW = 22;
              const path = `M${x1} ${y} q${loopW} -2 ${loopW} 8 q0 10 -${loopW} 8`;
              return (
                <g key={m.id} onMouseEnter={() => setHoverMsg(m.id)} onMouseLeave={() => setHoverMsg(null)}
                   style={{cursor:'pointer', opacity: hoverMsg && !hov ? 0.25 : 1}}>
                  <path d={path} fill="none" stroke={color} strokeWidth={hov ? 2 : 1.3} markerEnd={`url(#${marker})`}/>
                  <text x={x1 + loopW + 6} y={y + 5} className="seq-msg-label" fill={color}>{m.type}</text>
                </g>
              );
            }
            const dir = x2 >= x1 ? 1 : -1;
            const effX1 = x1 + dir * 6; const effX2 = x2 - dir * 6;
            const labelX = (x1 + x2) / 2;
            return (
              <g key={m.id} onMouseEnter={() => setHoverMsg(m.id)} onMouseLeave={() => setHoverMsg(null)}
                 style={{cursor:'pointer', opacity: hoverMsg && !hov ? 0.3 : 1, transition:'opacity 0.12s'}}>
                <line x1={effX1} y1={y} x2={effX2} y2={y} stroke={color}
                      strokeWidth={hov ? 2.2 : 1.4} markerEnd={`url(#${marker})`}
                      strokeDasharray={m.proto === 'mqtt-ws' ? '4 2' : undefined}/>
                <text x={labelX} y={y - 5} textAnchor="middle" className="seq-msg-label"
                      fill={hov ? 'var(--text)' : 'var(--text-muted)'}>
                  <tspan fill={color} fontWeight="600">{m.type}</tspan>
                  {m.summary && (
                    <tspan dx="6" fill={hov ? 'var(--text)' : 'var(--text-dim)'}>
                      {m.summary.length > 52 ? m.summary.slice(0,52) + '…' : m.summary}
                    </tspan>
                  )}
                </text>
                <line x1={Math.min(effX1, effX2)} x2={Math.max(effX1, effX2)} y1={y} y2={y}
                      stroke="transparent" strokeWidth="16"/>
              </g>
            );
          })}
          {messages.map((m, i) => {
            if (i % 5 !== 0) return null;
            const y = TIME_PAD_TOP + (i + 0.5) * ROW_H;
            const dtMs = now - m.ts;
            const label = dtMs < 1000 ? `${dtMs}ms` : `−${(dtMs/1000).toFixed(1)}s`;
            return (
              <g key={`tick-${i}`}>
                <line x1={LEFT_PAD - 8} x2={LEFT_PAD - 2} y1={y} y2={y} stroke="var(--text-dim)" strokeWidth="1"/>
                <text x={LEFT_PAD - 12} y={y + 3} textAnchor="end" className="seq-tick-label">{label}</text>
              </g>
            );
          })}
          {activeDevices.map((d) => {
            const i = colOfIp.get(d.ip);
            const x = colX(i); const y = svgH - HEADER_H - BOTTOM_PAD + 10;
            return <path key={`end-${d.ip}`} className="seq-end-cap" d={`M${x-4} ${y} L${x} ${y+8} L${x+4} ${y}`}
                    fill="none" strokeWidth="1.2" strokeLinejoin="round"/>;
          })}
        </svg>
      </div>
      {hoverMsg && (() => {
        const m = messages.find(x => x.id === hoverMsg);
        if (!m) return null;
        const sD = devMap.get(m.src); const dD = devMap.get(m.dst);
        if (!sD || !dD) return null;
        return (
          <div className="graph-inspect">
            <div className="gi-sub" style={{color: m.isError ? 'var(--err)' : undefined}}>
              {PROTO_LABEL[m.proto]}{m.isError ? ' · ERROR' : ''}
            </div>
            <h4>{sD.label} → {dD.label}</h4>
            <div className="gi-row"><span>Type</span><b>{m.type}</b></div>
            <div className="gi-row"><span>Bytes</span><b>{m.bytes}</b></div>
            <div className="gi-row"><span>Latency</span><b>{(m.latency || 0).toFixed(2)} ms</b></div>
          </div>
        );
      })()}
      {messages.length === 0 && (
        <div className="seq-empty"><b>No messages in buffer.</b>enable a protocol or start capture.</div>
      )}
    </div>
  );
}

// ---------- TOPOLOGY ----------
function TopologyView({ packets, showProtos, devMap, includePresets = false }) {
  const wrapRef = useRefG(null);
  const [size, setSize] = useStateG({ w: 900, h: 600 });
  const [hoverNode, setHoverNode] = useStateG(null);
  const [hoverEdge, setHoverEdge] = useStateG(null);
  useEffectG(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const r = e.contentRect;
        setSize({ w: Math.max(400, r.width), h: Math.max(300, r.height) });
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);
  const devices = useMemoG(() => devicesFromMap(devMap, includePresets), [devMap, includePresets]);
  const { edges, nodeStats } = useMemoG(() => buildStats(packets, showProtos, devMap), [packets, showProtos, devMap]);
  const maxEdge = Math.max(1, ...edges.map(e => e.count));
  const positions = useMemoG(() => {
    const W = size.w, H = size.h, PAD_T = 56, PAD_B = 40;
    const map = new Map();
    const presetIndex = new Map(devices.map((d, i) => [d.ip, i]));
    const activeScore = (ip) => {
      const s = nodeStats.get(ip);
      return s ? s.sent + s.recv : 0;
    };
    const placeMembers = (g, members) => {
      const cx = g.x * W;
      members.forEach((d, i) => {
        const cy = PAD_T + ((H - PAD_T - PAD_B) * (i + 0.5)) / members.length;
        map.set(d.ip, { x: cx, y: cy });
      });
    };

    for (const g of GROUPS) {
      placeMembers(g, devices.filter(d => d.group === g.id));
    }

    for (let pass = 0; pass < 3; pass++) {
      for (const g of GROUPS) {
        const members = devices.filter(d => d.group === g.id);
        const ranked = [...members].sort((a, b) => {
          const aActive = activeScore(a.ip) > 0;
          const bActive = activeScore(b.ip) > 0;
          if (aActive !== bActive) return aActive ? -1 : 1;
          const score = (ip) => {
            let sum = 0, weight = 0;
            for (const e of edges) {
              if (e.src !== ip && e.dst !== ip) continue;
              const other = e.src === ip ? e.dst : e.src;
              const p = map.get(other);
              if (!p) continue;
              sum += p.y * Math.max(1, e.count);
              weight += Math.max(1, e.count);
            }
            return weight ? sum / weight : (map.get(ip)?.y || 0);
          };
          return score(a.ip) - score(b.ip) || (presetIndex.get(a.ip) || 0) - (presetIndex.get(b.ip) || 0);
        });
        placeMembers(g, ranked);
      }
    }
    return map;
  }, [size.w, size.h, devices, edges, nodeStats]);
  const routeSlots = useMemoG(() => {
    const lanes = new Map();
    edges.forEach((e, index) => {
      const srcGroup = devMap.get(e.src)?.group || 'unknown';
      const dstGroup = devMap.get(e.dst)?.group || 'unknown';
      const key = `${srcGroup}>${dstGroup}`;
      if (!lanes.has(key)) lanes.set(key, []);
      const s = positions.get(e.src);
      const d = positions.get(e.dst);
      lanes.get(key).push({
        index,
        midY: s && d ? (s.y + d.y) / 2 : 0,
        protoRank: Object.keys(PROTO_OFFSET).indexOf(e.proto),
      });
    });
    const slots = new Map();
    lanes.forEach(list => {
      list.sort((a, b) => a.midY - b.midY || a.protoRank - b.protoRank || a.index - b.index);
      const center = (list.length - 1) / 2;
      list.forEach((item, i) => {
        const slot = Math.max(-44, Math.min(44, (i - center) * 7));
        slots.set(item.index, slot);
      });
    });
    return slots;
  }, [edges, positions, devMap]);
  const groupMeta = useMemoG(() => {
    const meta = new Map(GROUPS.map(g => [g.id, { total: 0, active: 0, packets: 0, errors: 0 }]));
    devices.forEach(d => {
      const m = meta.get(d.group);
      if (!m) return;
      const s = nodeStats.get(d.ip);
      m.total++;
      if (s && s.sent + s.recv > 0) m.active++;
    });
    edges.forEach(e => {
      const groups = new Set([devMap.get(e.src)?.group, devMap.get(e.dst)?.group].filter(Boolean));
      groups.forEach(group => {
        const m = meta.get(group);
        if (!m) return;
        m.packets += e.count;
        m.errors += e.errors;
      });
    });
    return meta;
  }, [devices, nodeStats, edges, devMap]);
  const roleShape = (role) => {
    if (role === 'plc' || role === 'broker' || role === 'gateway') return 'rect';
    if (role === 'sensor') return 'circle';
    return 'diamond';
  };
  const hoveredEndpoints = hoverEdge ? new Set([hoverEdge.src, hoverEdge.dst]) : null;
  const laneW = Math.max(86, Math.min(150, size.w * 0.13));
  return (
    <div className="topo-inner" ref={wrapRef}>
      <svg className="graph-svg" viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none">
        <defs>
          {Object.entries(PROTO_COLOR).map(([k, c]) => (
            <marker key={k} id={`topo-arr-${k}`} viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill={c} opacity="0.85"/>
            </marker>
          ))}
        </defs>
        {GROUPS.map(g => {
          const x = g.x * size.w;
          return (
            <g key={`lane-${g.id}`}>
              <rect className="topo-lane-band" x={x - laneW / 2} y="43"
                    width={laneW} height={Math.max(0, size.h - 84)} rx="0"/>
              <line className="topo-lane-axis" x1={x} x2={x} y1="47" y2={Math.max(47, size.h - 45)}/>
            </g>
          );
        })}
        {GROUPS.map(g => (
          <g key={g.id}>
            <text x={g.x * size.w} y="24" textAnchor="middle" className="graph-group-label">{g.title}</text>
            <text x={g.x * size.w} y="39" textAnchor="middle" className="graph-group-sub">
              {(() => {
                const m = groupMeta.get(g.id) || { active: 0, total: 0, packets: 0, errors: 0 };
                return `${m.active}/${m.total} active · ${m.packets} pkt${m.errors ? ` · ${m.errors} err` : ''}`;
              })()}
            </text>
          </g>
        ))}
        {edges.map((e, i) => {
          const s = positions.get(e.src); const d = positions.get(e.dst);
          if (!s || !d) return null;
          const sw = 0.8 + (e.count / maxEdge) * 4.4;
          const dim = (hoverNode && e.src !== hoverNode && e.dst !== hoverNode) || (hoverEdge && hoverEdge !== e);
          const active = (hoverNode && (e.src === hoverNode || e.dst === hoverNode)) || (hoverEdge === e);
          const laneOffset = routeSlots.get(i) || 0;
          const mx = (s.x + d.x) / 2; const my = (s.y + d.y) / 2 + (PROTO_OFFSET[e.proto] || 0) + laneOffset;
          const path = topologyPath(s, d, e.proto, laneOffset);
          return (
            <g key={i}>
              <path className="topo-edge-shadow" d={path} strokeWidth={sw + 3} fill="none"
                    opacity={dim ? 0 : active ? 0.22 : 0.12}/>
              <path className={`topo-edge proto-${e.proto}`} d={path} stroke={PROTO_COLOR[e.proto]} strokeWidth={sw} fill="none"
                    opacity={dim ? 0.12 : active ? 0.95 : 0.55}
                    style={{transition: 'opacity 0.15s'}} markerEnd={`url(#topo-arr-${e.proto})`}/>
              {e.errors > 0 && <circle cx={mx} cy={my} r="3" fill="var(--err)" opacity={dim ? 0.3 : 1}/>}
              <path d={path} stroke="transparent" strokeWidth="14" fill="none"
                    onMouseEnter={() => setHoverEdge(e)} onMouseLeave={() => setHoverEdge(null)}
                    style={{cursor:'pointer'}}/>
            </g>
          );
        })}
        {devices.map(d => {
          const pos = positions.get(d.ip); if (!pos) return null;
          const stats = nodeStats.get(d.ip) || { sent:0, recv:0, bytes:0, errors:0, protos: new Set() };
          const isHov = hoverNode === d.ip;
          const dim = (hoverNode && hoverNode !== d.ip) || (hoveredEndpoints && !hoveredEndpoints.has(d.ip));
          const shape = roleShape(d.role);
          const protosArr = Array.from(stats.protos);
          const primary = protosArr.length ? PROTO_COLOR[protosArr[0]] : 'var(--text-muted)';
          const active = stats.sent + stats.recv > 0;
          return (
            <g key={d.ip} transform={`translate(${pos.x}, ${pos.y})`}
               onMouseEnter={() => setHoverNode(d.ip)} onMouseLeave={() => setHoverNode(null)}
               style={{cursor:'pointer', opacity: dim ? 0.18 : active ? 1 : 0.38, transition:'opacity 0.15s'}}>
              {active && <circle r={isHov ? 24 : 18} fill={primary} opacity={isHov ? 0.18 : 0.08}/>}
              {shape === 'rect' && <rect x="-11" y="-11" width="22" height="22" rx="3"
                    fill="var(--bg-panel)" stroke={primary} strokeWidth={isHov ? 2 : 1.6}/>}
              {shape === 'circle' && <circle r="10" fill="var(--bg-panel)" stroke={primary} strokeWidth={isHov ? 2 : 1.6}/>}
              {shape === 'diamond' && <rect x="-9" y="-9" width="18" height="18" rx="2" transform="rotate(45)"
                    fill="var(--bg-panel)" stroke={primary} strokeWidth={isHov ? 2 : 1.6}/>}
              {active && <circle r="2.4" fill={primary}/>}
              <text x="0" y="26" textAnchor="middle" className="graph-node-label">{d.label}</text>
              <text x="0" y="38" textAnchor="middle" className="graph-node-sub">{d.ip}</text>
            </g>
          );
        })}
      </svg>
      {(hoverNode || hoverEdge) && (
        <div className="graph-inspect">
          {hoverNode && !hoverEdge && (() => {
            const d = devMap.get(hoverNode); const s = nodeStats.get(hoverNode);
            if (!d || !s) return null;
            return (<>
              <div className="gi-sub">{d.role.toUpperCase()}</div>
              <h4>{d.label}</h4>
              <div className="gi-row"><span>IP</span><b>{d.ip}</b></div>
              <div className="gi-row"><span>Sent</span><b>{s.sent}</b></div>
              <div className="gi-row"><span>Recv</span><b>{s.recv}</b></div>
              <div className="gi-row"><span>Bytes</span><b>{s.bytes.toLocaleString()}</b></div>
              <div className="gi-row"><span>Errors</span><b style={{color: s.errors ? 'var(--err)' : undefined}}>{s.errors}</b></div>
            </>);
          })()}
          {hoverEdge && (() => {
            const sD = devMap.get(hoverEdge.src); const dD = devMap.get(hoverEdge.dst);
            if (!sD || !dD) return null;
            return (<>
              <div className="gi-sub">{PROTO_LABEL[hoverEdge.proto]} flow</div>
              <h4>{sD.label} → {dD.label}</h4>
              <div className="gi-row"><span>Packets</span><b>{hoverEdge.count}</b></div>
              <div className="gi-row"><span>Bytes</span><b>{hoverEdge.bytes.toLocaleString()}</b></div>
              <div className="gi-row"><span>Errors</span><b style={{color: hoverEdge.errors ? 'var(--err)' : undefined}}>{hoverEdge.errors}</b></div>
            </>);
          })()}
        </div>
      )}
    </div>
  );
}

// ---------- MATRIX ----------
function MatrixView({ packets, showProtos, devMap, includePresets = false }) {
  const [hoverCell, setHoverCell] = useStateG(null);
  const [hoverNode, setHoverNode] = useStateG(null);
  const devices = useMemoG(() => devicesFromMap(devMap, includePresets), [devMap, includePresets]);
  const { pairMat, nodeStats } = useMemoG(() => buildStats(packets, showProtos, devMap), [packets, showProtos, devMap]);
  const activeIps = useMemoG(() => {
    const seen = new Set();
    nodeStats.forEach((s, ip) => { if (s.sent + s.recv > 0) seen.add(ip); });
    return devices.filter(d => seen.has(d.ip)).map(d => d.ip);
  }, [nodeStats, devices]);
  const maxCount = useMemoG(() => {
    let mx = 0; pairMat.forEach(v => { if (v.count > mx) mx = v.count; });
    return Math.max(1, mx);
  }, [pairMat]);
  const cellColor = (cell) => {
    if (!cell || cell.count === 0) return 'var(--bg)';
    if (cell.errors > 0) return `oklch(0.68 0.20 25 / ${0.25 + 0.6 * (cell.count / maxCount)})`;
    const dom = Array.from(cell.protos)[0] || 'modbus';
    const base = PROTO_COLOR[dom];
    const a = 0.18 + 0.65 * (cell.count / maxCount);
    return base.replace(')', ` / ${a.toFixed(2)})`);
  };
  const labelFor = (ip) => devMap.get(ip)?.label || ip;

  return (
    <div className="matrix-inner">
      <div className="matrix-left">
        <div className="matrix-section-title">Graph · {activeIps.length} active nodes</div>
        <CircularGraph ips={activeIps} pairMat={pairMat} devMap={devMap}
                       hoverNode={hoverNode} setHoverNode={setHoverNode}
                       hoverCell={hoverCell}/>
      </div>
      <div className="matrix-right">
        <div className="matrix-section-title">Adjacency · pkt count</div>
        <div className="mx-scroll">
          <table className="mx-table">
            <thead>
              <tr>
                <th className="mx-corner"></th>
                {activeIps.map(ip => {
                  const hl = hoverNode === ip || hoverCell?.src === ip || hoverCell?.dst === ip;
                  return (
                    <th key={ip} className={"mx-col-head" + (hl ? ' hl' : '')}
                        onMouseEnter={() => setHoverNode(ip)}
                        onMouseLeave={() => setHoverNode(null)}>
                      <span>{labelFor(ip)}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {activeIps.map(rIp => {
                const rowHl = hoverNode === rIp || hoverCell?.src === rIp;
                return (
                  <tr key={rIp}>
                    <th className={"mx-row-head" + (rowHl ? ' hl' : '')}
                        onMouseEnter={() => setHoverNode(rIp)}
                        onMouseLeave={() => setHoverNode(null)}>
                      {labelFor(rIp)}
                    </th>
                    {activeIps.map(cIp => {
                      const cell = pairMat.get(`${rIp}|${cIp}`);
                      const diag = rIp === cIp;
                      const count = cell?.count || 0;
                      const bg = diag ? 'var(--bg-panel)' : cellColor(cell);
                      const isHov = hoverCell?.src === rIp && hoverCell?.dst === cIp;
                      return (
                        <td key={cIp}
                            className={"mx-cell" + (diag ? ' diag' : '') + (isHov ? ' hov' : '') + (cell?.errors > 0 ? ' err' : '')}
                            style={{background: bg}}
                            onMouseEnter={() => !diag && count > 0 && setHoverCell({src: rIp, dst: cIp})}
                            onMouseLeave={() => setHoverCell(null)}>
                          {diag ? '—' : count > 0 ? (count > 999 ? `${Math.round(count/100)/10}k` : count) : ''}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mx-scale">
            <span>0</span>
            <div className="mx-scale-bar">
              <span style={{background:'oklch(0.74 0.12 195 / 0.2)'}}></span>
              <span style={{background:'oklch(0.74 0.12 195 / 0.5)'}}></span>
              <span style={{background:'oklch(0.74 0.12 195 / 0.85)'}}></span>
            </div>
            <span>{maxCount} pkt</span>
          </div>
        </div>
      </div>
      {(hoverCell || hoverNode) && (
        <div className="graph-inspect matrix-inspect">
          {hoverCell && (() => {
            const sD = devMap.get(hoverCell.src); const dD = devMap.get(hoverCell.dst);
            if (!sD || !dD) return null;
            const cell = pairMat.get(`${hoverCell.src}|${hoverCell.dst}`) || { count: 0, bytes: 0, errors: 0, protos: new Set() };
            return (<>
              <div className="gi-sub">Pair flow</div>
              <h4>{sD.label} → {dD.label}</h4>
              <div className="gi-row"><span>Packets</span><b>{cell.count}</b></div>
              <div className="gi-row"><span>Bytes</span><b>{cell.bytes.toLocaleString()}</b></div>
              <div className="gi-row"><span>Errors</span><b style={{color: cell.errors ? 'var(--err)' : undefined}}>{cell.errors}</b></div>
              <div className="gi-row"><span>Protocols</span><b>{Array.from(cell.protos).map(p => PROTO_LABEL[p]).join(', ') || '—'}</b></div>
            </>);
          })()}
          {hoverNode && !hoverCell && (() => {
            const d = devMap.get(hoverNode); const s = nodeStats.get(hoverNode);
            if (!d || !s) return null;
            return (<>
              <div className="gi-sub">{d.role.toUpperCase()}</div>
              <h4>{d.label}</h4>
              <div className="gi-row"><span>IP</span><b>{d.ip}</b></div>
              <div className="gi-row"><span>Sent</span><b>{s.sent}</b></div>
              <div className="gi-row"><span>Recv</span><b>{s.recv}</b></div>
              <div className="gi-row"><span>Bytes</span><b>{s.bytes.toLocaleString()}</b></div>
            </>);
          })()}
        </div>
      )}
      {activeIps.length === 0 && (
        <div className="seq-empty"><b>No pair activity yet.</b>enable a protocol or start capture.</div>
      )}
    </div>
  );
}

function CircularGraph({ ips, pairMat, devMap, hoverNode, setHoverNode, hoverCell }) {
  const wrapRef = useRefG(null);
  const [size, setSize] = useStateG({ w: 300, h: 300 });
  useEffectG(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const r = e.contentRect;
        const s = Math.min(r.width, r.height);
        setSize({ w: Math.max(200, s), h: Math.max(200, s) });
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);
  const W = size.w, H = size.h;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 48;
  const positions = new Map();
  ips.forEach((ip, i) => {
    const a = (-Math.PI / 2) + (i / Math.max(1, ips.length)) * Math.PI * 2;
    positions.set(ip, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a });
  });
  const highlightSet = hoverNode
    ? new Set([hoverNode])
    : hoverCell ? new Set([hoverCell.src, hoverCell.dst]) : null;
  return (
    <div className="circular-wrap" ref={wrapRef}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%">
        {Array.from(pairMat.entries()).map(([k, v]) => {
          const [src, dst] = k.split('|');
          const s = positions.get(src); const d = positions.get(dst);
          if (!s || !d) return null;
          const active = hoverNode && (src === hoverNode || dst === hoverNode);
          const isPair = hoverCell && hoverCell.src === src && hoverCell.dst === dst;
          const dim = (hoverNode && !active) || (hoverCell && !isPair);
          const dom = Array.from(v.protos)[0] || 'modbus';
          const color = v.errors > 0 ? 'var(--err)' : PROTO_COLOR[dom];
          return (
            <line key={k} x1={s.x} y1={s.y} x2={d.x} y2={d.y}
                  stroke={color}
                  strokeWidth={isPair ? 2.4 : active ? 1.8 : 1.1}
                  opacity={dim ? 0.1 : isPair || active ? 0.95 : 0.4}/>
          );
        })}
        {ips.map((ip, i) => {
          const p = positions.get(ip); if (!p) return null;
          const d = devMap.get(ip); if (!d) return null;
          const isHov = hoverNode === ip;
          const hl = highlightSet && highlightSet.has(ip);
          const dim = highlightSet && !hl;
          const la = p.a;
          const stagger = (i % 2 === 0) ? 16 : 32;
          const lx = cx + (R + stagger) * Math.cos(la);
          const ly = cy + (R + stagger) * Math.sin(la);
          const anchor = Math.cos(la) > 0.25 ? 'start' : Math.cos(la) < -0.25 ? 'end' : 'middle';
          const short = d.label.replace(/^sensor-/, 's').replace(/^broker-/, 'b').replace(/^PLC-/, 'P').replace(/^HMI-/, 'H').replace(/^edge-/, 'e').replace(/^host-/, 'h');
          return (
            <g key={ip}
               onMouseEnter={() => setHoverNode(ip)} onMouseLeave={() => setHoverNode(null)}
               style={{cursor:'pointer', opacity: dim ? 0.3 : 1, transition:'opacity 0.15s'}}>
              <circle cx={p.x} cy={p.y} r={isHov ? 10 : 7}
                      fill="var(--modbus-bg)"
                      stroke={isHov ? 'var(--text)' : 'var(--modbus)'}
                      strokeWidth="1.5"/>
              <text x={lx} y={ly + 3} textAnchor={anchor}
                    className="graph-node-label" style={{fontSize:9.5, fontWeight: isHov ? 600 : 500}}>
                {isHov ? d.label : short}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------- HOSTS MODAL ----------
// Editable table of every device we know about. Edits flow up via onChange,
// which persists to localStorage and triggers a devMap rebuild.
function HostsModal({ onClose, devMap, packets, overrides, onChange, includePresets = false }) {
  const [showInactive, setShowInactive] = useStateG(false);
  const [filter, setFilter] = useStateG('');

  // Packet count per IP, for the right-hand activity column.
  const counts = useMemoG(() => {
    const c = new Map();
    for (const p of packets) {
      const s = ipOf(p.src); const d = ipOf(p.dst);
      c.set(s, (c.get(s) || 0) + 1);
      c.set(d, (c.get(d) || 0) + 1);
    }
    return c;
  }, [packets]);

  const allDevices = useMemoG(() => devicesFromMap(devMap, includePresets), [devMap, includePresets]);
  const listed = useMemoG(() => {
    const q = filter.trim().toLowerCase();
    return allDevices.filter(d => {
      const n = counts.get(d.ip) || 0;
      if (!showInactive && n === 0) return false;
      if (!q) return true;
      return d.ip.includes(q) || (d.label || '').toLowerCase().includes(q) ||
             (d.detail || '').toLowerCase().includes(q) || (d.role || '').includes(q);
    });
  }, [allDevices, counts, showInactive, filter]);

  const updateField = (ip, field, value) => {
    const next = { ...(overrides || {}) };
    const cur = { ...(next[ip] || {}) };
    if (value === '' || value == null) delete cur[field];
    else cur[field] = value;
    if (Object.keys(cur).length === 0) delete next[ip];
    else next[ip] = cur;
    onChange(next);
  };

  const resetRow = (ip) => {
    if (!overrides || !overrides[ip]) return;
    const next = { ...overrides }; delete next[ip];
    onChange(next);
  };

  const clearAll = () => {
    if (!Object.keys(overrides || {}).length) return;
    if (confirm('Remove all host label overrides?')) onChange({});
  };

  const overrideCount = Object.keys(overrides || {}).length;

  return (
    <div className="hosts-backdrop" onClick={onClose}>
      <div className="hosts-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Host labels">
        <div className="hosts-head">
          <div>
            <h3>Host labels</h3>
            <div className="hosts-sub">click a field to edit · stored in this browser</div>
          </div>
          <button className="hosts-close" onClick={onClose} title="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M2 2l8 8M10 2l-8 8" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="hosts-controls">
          <input className="hosts-filter" placeholder="filter by ip, label, role…"
                 value={filter} onChange={e => setFilter(e.target.value)}/>
          <label className="hosts-toggle">
            <input type="checkbox" checked={showInactive}
                   onChange={e => setShowInactive(e.target.checked)}/>
            show inactive
          </label>
          <span className="hosts-spacer"></span>
          <span className="hosts-count">{overrideCount} custom</span>
          <button className="hosts-clear" onClick={clearAll} disabled={overrideCount === 0}>
            clear all
          </button>
        </div>

        <div className="hosts-body">
          <table className="hosts-table">
            <thead>
              <tr>
                <th className="col-ip">IP</th>
                <th className="col-label">Label</th>
                <th className="col-role">Role</th>
                <th className="col-detail">Detail</th>
                <th className="col-pkts">Packets</th>
                <th className="col-reset"></th>
              </tr>
            </thead>
            <tbody>
              {listed.map(d => {
                const ov = (overrides || {})[d.ip];
                const n = counts.get(d.ip) || 0;
                const hasOverride = !!(ov && Object.keys(ov).length);
                return (
                  <tr key={d.ip} className={n > 0 ? 'active' : 'inactive'}>
                    <td className="col-ip mono">{d.ip}</td>
                    <td>
                      <input type="text" className="hosts-input"
                             value={d.label}
                             onChange={e => updateField(d.ip, 'label', e.target.value)}/>
                    </td>
                    <td>
                      <select className="hosts-select"
                              value={ROLE_OPTIONS.find(r => r.id === d.role) ? d.role : 'edge'}
                              onChange={e => updateField(d.ip, 'role', e.target.value)}>
                        {ROLE_OPTIONS.map(r => (
                          <option key={r.id} value={r.id}>{r.label}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="text" className="hosts-input"
                             value={d.detail || ''}
                             placeholder="note (optional)"
                             onChange={e => updateField(d.ip, 'detail', e.target.value)}/>
                    </td>
                    <td className="col-pkts mono">{n.toLocaleString()}</td>
                    <td className="col-reset">
                      {hasOverride
                        ? <button className="hosts-row-reset" onClick={() => resetRow(d.ip)} title="Reset to default">↺</button>
                        : <span className="hosts-row-dash">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {listed.length === 0 && (
            <div className="hosts-empty">
              {filter
                ? <>no hosts match <b>{filter}</b></>
                : showInactive
                  ? <>no hosts known yet</>
                  : <>no active hosts — toggle "show inactive" to see saved hosts</>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- WRAPPER ----------
function ConnectionGraph({ packets, demo = false }) {
  const initialView = (() => {
    const v = new URLSearchParams(location.search).get('view');
    return (v === 'topology' || v === 'matrix' || v === 'sequence') ? v : 'sequence';
  })();
  const [view, setView] = useStateG(initialView);
  const [showProtos, setShowProtos] = useStateG(new Set(['modbus','mqtt-tcp','mqtt-ws']));
  const [overrides, setOverrides] = useStateG(() => loadHostLabels());
  const [showHostsModal, setShowHostsModal] = useStateG(false);
  const includePresets = !!demo;
  const toggleProto = (id) => setShowProtos(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const updateOverrides = (next) => {
    setOverrides(next);
    saveHostLabels(next);
  };
  // Recompute device map whenever packet set changes — lets live-mode IPs
  // auto-populate. For performance on big buffers, only rebuild when the
  // set of unique src/dst endpoints changes.
  const endpointKey = useMemoG(() => {
    const s = new Set();
    for (const p of packets) { s.add(p.src); s.add(p.dst); }
    return Array.from(s).sort().join('|');
  }, [packets]);
  const devMap = useMemoG(
    () => buildDeviceMap(packets, overrides, includePresets),
    [endpointKey, overrides, includePresets]
  );

  return (
    <div className="graph-wrap">
      <div className="graph-grid"></div>
      <div className="graph-toolbar">
        <div className="view-switch">
          {[
            { id: 'sequence', label: 'Sequence' },
            { id: 'topology', label: 'Topology' },
            { id: 'matrix', label: 'Matrix' },
          ].map(b => (
            <button key={b.id}
                    className={"view-btn" + (view === b.id ? ' active' : '')}
                    onClick={() => setView(b.id)}>{b.label}</button>
          ))}
        </div>
        <div className="graph-toolbar-right">
          <div className="seq-ctrl-group">
            {['modbus','mqtt-tcp','mqtt-ws'].map(p => (
              <button key={p}
                      className={"seq-chip " + p + (showProtos.has(p) ? ' on' : '')}
                      onClick={() => toggleProto(p)}>
                <span className="seq-chip-dot"></span>{PROTO_LABEL[p]}
              </button>
            ))}
          </div>
          <button className="hosts-btn" onClick={() => setShowHostsModal(true)} title="Edit host labels">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M2 13L10.5 4.5a1.8 1.8 0 012.5 2.5L4.5 15.5H2V13z" strokeLinejoin="round"/>
              <path d="M9 6l2.5 2.5" strokeLinecap="round"/>
            </svg>
            Hosts
          </button>
        </div>
      </div>
      {view === 'sequence' && <SequenceView packets={packets} showProtos={showProtos} devMap={devMap} includePresets={includePresets}/>}
      {view === 'topology' && <TopologyView packets={packets} showProtos={showProtos} devMap={devMap} includePresets={includePresets}/>}
      {view === 'matrix'   && <MatrixView   packets={packets} showProtos={showProtos} devMap={devMap} includePresets={includePresets}/>}
      {showHostsModal && (
        <HostsModal onClose={() => setShowHostsModal(false)}
                    devMap={devMap} packets={packets}
                    overrides={overrides} onChange={updateOverrides}
                    includePresets={includePresets}/>
      )}
    </div>
  );
}

window.ConnectionGraph = ConnectionGraph;
