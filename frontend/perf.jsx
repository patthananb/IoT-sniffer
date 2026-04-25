// Performance / scientific analysis tab.
//
// Consumes `perf` snapshots pushed by the backend (one every ~5s) and the
// 1 Hz `metrics` stream piped in via props. Renders:
//
//   1. Per-protocol latency stat tiles (n / mean / p50 / p95 / p99 / stddev)
//   2. Latency time-series chart (last 5 min, p50/p95/p99 per protocol)
//   3. Cumulative-distribution-function (CDF) chart, one curve per protocol
//   4. Inter-arrival jitter mean/stddev per protocol
//   5. Frame-size distribution per protocol
//   6. Per-flow stats table (sortable by latency / packets / bytes)
//   7. Live throughput / metrics history sparkline
//   8. Export buttons: latency samples CSV, per-flow CSV, full metrics CSV
//
// Demo mode: synthesises a small per-protocol stub from the in-memory
// packets list so the layout renders without a backend.

(function () {
  const { useState, useEffect, useMemo, useRef } = React;

  const PROTOS = ['modbus', 'mqtt-tcp', 'mqtt-ws'];
  const PROTO_LABEL = {
    'modbus': 'Modbus/TCP',
    'mqtt-tcp': 'MQTT/TCP',
    'mqtt-ws': 'MQTT/WS',
  };
  const PROTO_COLOR = {
    'modbus': 'oklch(0.74 0.12 195)',
    'mqtt-tcp': 'oklch(0.80 0.14 75)',
    'mqtt-ws': 'oklch(0.74 0.14 25)',
  };

  function fmtMs(v) {
    if (!isFinite(v)) return '0.0';
    if (v < 1) return v.toFixed(3);
    if (v < 10) return v.toFixed(2);
    if (v < 1000) return v.toFixed(1);
    return v.toFixed(0);
  }
  function fmtNum(v) {
    if (v == null || !isFinite(v)) return '0';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return Math.round(v).toLocaleString();
  }
  function fmtBytes(b) {
    if (!b) return '0 B';
    if (b < 1024) return `${Math.round(b)} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  }

  // ---- Stat tiles (per protocol) ----
  function ProtoStatTile({ proto, lat, iat, size, isEmpty }) {
    return (
      <div className={"perf-tile " + proto}>
        <div className="perf-tile-head">
          <span className={"perf-tile-tag " + proto}>{PROTO_LABEL[proto]}</span>
          <span className="perf-tile-n">n={fmtNum(lat?.n_total)}</span>
        </div>
        <div className="perf-tile-grid">
          <div><span className="lbl">mean</span><span className="val">{fmtMs(lat?.mean)} ms</span></div>
          <div><span className="lbl">p50</span><span className="val">{fmtMs(lat?.p50)} ms</span></div>
          <div><span className="lbl">p95</span><span className="val">{fmtMs(lat?.p95)} ms</span></div>
          <div><span className="lbl">p99</span><span className="val">{fmtMs(lat?.p99)} ms</span></div>
          <div><span className="lbl">σ</span><span className="val">{fmtMs(lat?.stddev)} ms</span></div>
          <div><span className="lbl">max</span><span className="val">{fmtMs(lat?.max)} ms</span></div>
          <div><span className="lbl">IAT μ</span><span className="val">{fmtMs(iat?.mean)} ms</span></div>
          <div><span className="lbl">IAT σ</span><span className="val">{fmtMs(iat?.stddev)} ms</span></div>
          <div><span className="lbl">size μ</span><span className="val">{fmtNum(size?.mean)} B</span></div>
          <div><span className="lbl">size p95</span><span className="val">{fmtNum(size?.p95)} B</span></div>
        </div>
        {isEmpty && (
          <div className="perf-tile-empty">no samples yet</div>
        )}
      </div>
    );
  }

  // ---- Generic line chart used by both time-series and CDF ----
  function LineChart({ width = 720, height = 220, padL = 44, padR = 14, padT = 8, padB = 28,
                      series, xLabel, yLabel, xDomain, yDomain, yLog = false,
                      xTickFmt, yTickFmt, title }) {
    const W = width, H = height;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    let xs = [], ys = [];
    for (const s of series) for (const p of s.points) { xs.push(p[0]); ys.push(p[1]); }
    const xMin = xDomain ? xDomain[0] : (xs.length ? Math.min(...xs) : 0);
    const xMax = xDomain ? xDomain[1] : (xs.length ? Math.max(...xs) : 1);
    let yMin = yDomain ? yDomain[0] : 0;
    let yMax = yDomain ? yDomain[1] : (ys.length ? Math.max(...ys) : 1);
    if (yMax <= yMin) yMax = yMin + 1;

    const yScale = (v) => {
      if (yLog) {
        const lo = Math.max(yMin, 0.01);
        const hi = Math.max(yMax, lo * 10);
        const t = (Math.log10(Math.max(v, lo)) - Math.log10(lo)) /
                  (Math.log10(hi) - Math.log10(lo));
        return padT + (1 - t) * plotH;
      }
      return padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
    };
    const xScale = (v) => padL + ((v - xMin) / Math.max(1e-9, xMax - xMin)) * plotW;

    const yTicks = 4;
    const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) => yMin + (yMax - yMin) * (i / yTicks));
    const xTicks = 4;
    const xTickVals = Array.from({ length: xTicks + 1 }, (_, i) => xMin + (xMax - xMin) * (i / xTicks));

    return (
      <>
        {title && <div className="perf-chart-title">{title}</div>}
      <svg className="perf-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {yTickVals.map((v, i) => (
          <g key={'y' + i}>
            <line x1={padL} x2={padL + plotW} y1={yScale(v)} y2={yScale(v)}
                  stroke="oklch(0.28 0.014 240)" strokeDasharray="2 3" strokeWidth="1"/>
            <text x={padL - 6} y={yScale(v) + 3} className="perf-chart-tick"
                  textAnchor="end">{yTickFmt ? yTickFmt(v) : v.toFixed(1)}</text>
          </g>
        ))}
        {xTickVals.map((v, i) => (
          <text key={'x' + i} x={xScale(v)} y={H - 8}
                className="perf-chart-tick" textAnchor="middle">
            {xTickFmt ? xTickFmt(v) : v.toFixed(1)}
          </text>
        ))}
        {/* axes */}
        <line x1={padL} x2={padL + plotW} y1={padT + plotH} y2={padT + plotH}
              stroke="oklch(0.36 0.014 240)" strokeWidth="1"/>
        <line x1={padL} x2={padL} y1={padT} y2={padT + plotH}
              stroke="oklch(0.36 0.014 240)" strokeWidth="1"/>
        {/* labels */}
        {yLabel && <text x={8} y={padT + plotH / 2} className="perf-chart-axis"
                          transform={`rotate(-90 8 ${padT + plotH / 2})`} textAnchor="middle">{yLabel}</text>}
        {xLabel && <text x={padL + plotW / 2} y={H - 1} className="perf-chart-axis" textAnchor="middle">{xLabel}</text>}
        {/* lines */}
        {series.map((s, i) => {
          const path = s.points.map((p, j) => {
            const x = xScale(p[0]).toFixed(1);
            const y = yScale(p[1]).toFixed(1);
            return `${j === 0 ? 'M' : 'L'}${x} ${y}`;
          }).join(' ');
          return (
            <g key={i}>
              <path d={path} fill="none" stroke={s.color}
                    strokeWidth={s.width || 1.5}
                    strokeDasharray={s.dash || ''}
                    strokeLinejoin="round"/>
            </g>
          );
        })}
      </svg>
      </>
    );
  }

  // ---- Time-series of latency percentiles (p50/p95/p99) per protocol ----
  function LatencyTimeSeriesChart({ tsSeries }) {
    const series = [];
    const allTs = [];
    let yMax = 1;
    for (const proto of PROTOS) {
      const buckets = tsSeries[proto] || [];
      if (!buckets.length) continue;
      const p50 = buckets.map(b => [b.ts, b.p50]);
      const p95 = buckets.map(b => [b.ts, b.p95]);
      const p99 = buckets.map(b => [b.ts, b.p99]);
      buckets.forEach(b => {
        allTs.push(b.ts);
        yMax = Math.max(yMax, b.p99);
      });
      series.push({ points: p50, color: PROTO_COLOR[proto], width: 1.4 });
      series.push({ points: p95, color: PROTO_COLOR[proto], width: 1.4, dash: '4 3' });
      series.push({ points: p99, color: PROTO_COLOR[proto], width: 1.6, dash: '1 3' });
    }
    if (!series.length) {
      return <EmptyChart label="latency time-series — waiting for data"/>;
    }
    const xMin = Math.min(...allTs);
    const xMax = Math.max(...allTs);
    const xTickFmt = (t) => {
      const d = new Date(t * 1000);
      return d.toLocaleTimeString();
    };
    return (
      <LineChart
        title="Latency over time · p50 (solid) · p95 (dashed) · p99 (dotted)"
        series={series}
        xDomain={[xMin, xMax]} yDomain={[0, yMax * 1.1]}
        xLabel="time" yLabel="latency (ms)"
        xTickFmt={xTickFmt}
        yTickFmt={(v) => fmtMs(v)}
      />
    );
  }

  // ---- Latency CDF, one line per protocol ----
  function LatencyCdfChart({ perProto }) {
    const series = [];
    let xMax = 1;
    for (const proto of PROTOS) {
      const cdf = perProto[proto]?.cdf || [];
      if (!cdf.length) continue;
      cdf.forEach(p => { if (p[0] > xMax) xMax = p[0]; });
      series.push({
        points: cdf,
        color: PROTO_COLOR[proto],
        width: 1.6,
      });
    }
    if (!series.length) {
      return <EmptyChart label="CDF — waiting for samples"/>;
    }
    return (
      <LineChart
        title="Latency CDF (cumulative distribution)"
        series={series}
        xDomain={[0, xMax * 1.05]} yDomain={[0, 1]}
        xLabel="latency (ms)" yLabel="P(X ≤ x)"
        xTickFmt={(v) => fmtMs(v)}
        yTickFmt={(v) => v.toFixed(1)}
      />
    );
  }

  // ---- Frame-size distribution: discretised mean / p50 / p95 bars ----
  function SizeBarChart({ perProto }) {
    const rows = PROTOS.map(p => {
      const s = perProto[p]?.size_bytes;
      return { proto: p, mean: s?.mean || 0, p50: s?.p50 || 0, p95: s?.p95 || 0, max: s?.max || 0 };
    });
    const max = Math.max(1, ...rows.map(r => r.max));
    return (
      <div className="perf-size-bars">
        <div className="perf-section-title">Frame size distribution (bytes)</div>
        {rows.map(r => (
          <div className={"perf-size-row " + r.proto} key={r.proto}>
            <div className="perf-size-lbl"><span className={"perf-tile-tag " + r.proto}>{PROTO_LABEL[r.proto]}</span></div>
            <div className="perf-size-bar-track">
              <div className="perf-size-bar-fill"
                   style={{ width: `${(r.p95 / max) * 100}%`, background: PROTO_COLOR[r.proto] }}/>
              <div className="perf-size-bar-tick"
                   style={{ left: `${(r.mean / max) * 100}%` }}
                   title={`mean ${fmtNum(r.mean)} B`}/>
              <div className="perf-size-bar-tick mid"
                   style={{ left: `${(r.p50 / max) * 100}%` }}
                   title={`p50 ${fmtNum(r.p50)} B`}/>
            </div>
            <div className="perf-size-vals">
              <span>μ <b>{fmtNum(r.mean)}</b></span>
              <span>p50 <b>{fmtNum(r.p50)}</b></span>
              <span>p95 <b>{fmtNum(r.p95)}</b></span>
              <span>max <b>{fmtNum(r.max)}</b></span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ---- IAT (inter-arrival time) compact chart ----
  function IatChart({ perProto }) {
    const rows = PROTOS.map(p => {
      const s = perProto[p]?.iat_ms;
      return { proto: p, mean: s?.mean || 0, stddev: s?.stddev || 0, max: s?.max || 0, n: s?.n_total || 0 };
    });
    const max = Math.max(1, ...rows.map(r => r.max));
    return (
      <div className="perf-iat">
        <div className="perf-section-title">Inter-arrival time</div>
        {rows.map(r => (
          <div className="perf-iat-row" key={r.proto}>
            <div className="perf-iat-lbl"><span className={"perf-tile-tag " + r.proto}>{PROTO_LABEL[r.proto]}</span></div>
            <div className="perf-iat-bar-track">
              <div className="perf-iat-bar-fill"
                   style={{ width: `${(r.mean / max) * 100}%`, background: PROTO_COLOR[r.proto] }}/>
              <div className="perf-iat-bar-stddev"
                   style={{ left: `${(Math.max(0, r.mean - r.stddev) / max) * 100}%`,
                            width: `${((Math.min(max, r.mean + r.stddev) - Math.max(0, r.mean - r.stddev)) / max) * 100}%` }}/>
            </div>
            <div className="perf-iat-vals">
              <span>μ <b>{fmtMs(r.mean)} ms</b></span>
              <span>σ <b>{fmtMs(r.stddev)} ms</b></span>
              <span>max <b>{fmtMs(r.max)} ms</b></span>
              <span>n <b>{fmtNum(r.n)}</b></span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ---- Per-flow table ----
  function PerFlowTable({ perFlow }) {
    const [sort, setSort] = useState({ key: 'p99', dir: 'desc' });
    const sorted = useMemo(() => {
      const rows = [...perFlow];
      const cmp = (a, b) => {
        const get = (r) => {
          switch (sort.key) {
            case 'src':      return `${r.flow[0]}:${r.flow[1]}`;
            case 'dst':      return `${r.flow[2]}:${r.flow[3]}`;
            case 'protocol': return r.protocol;
            case 'packets':  return r.packets;
            case 'bytes':    return r.bytes;
            case 'mean':     return r.latency_ms.mean;
            case 'p95':      return r.latency_ms.p95;
            case 'p99':      return r.latency_ms.p99;
            case 'max':      return r.latency_ms.max;
            case 'last':     return r.last_ts;
            default:         return 0;
          }
        };
        const av = get(a), bv = get(b);
        if (av < bv) return sort.dir === 'asc' ? -1 : 1;
        if (av > bv) return sort.dir === 'asc' ? 1 : -1;
        return 0;
      };
      rows.sort(cmp);
      return rows;
    }, [perFlow, sort]);

    const head = [
      ['src', 'Source'], ['dst', 'Destination'], ['protocol', 'Proto'],
      ['packets', 'Pkts'], ['bytes', 'Bytes'],
      ['mean', 'mean ms'], ['p95', 'p95 ms'], ['p99', 'p99 ms'], ['max', 'max ms'],
      ['last', 'Last seen'],
    ];

    return (
      <div className="perf-flow-table">
        <div className="perf-section-title">Per-flow latency table <span style={{color:'var(--text-dim)', fontWeight:400, marginLeft:8}}>{sorted.length} flows</span></div>
        <div className="perf-flow-head">
          {head.map(([k, label]) => (
            <div key={k} className={"perf-flow-cell " + (sort.key === k ? 'sort-' + sort.dir : '')}
                 onClick={() => setSort(s => s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' })}>
              {label}
              {sort.key === k && <span className="perf-flow-arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
            </div>
          ))}
        </div>
        <div className="perf-flow-body">
          {sorted.length === 0 && <div className="perf-flow-empty">no flows yet — waiting for capture</div>}
          {sorted.map((r, i) => {
            const last = r.last_ts ? new Date(r.last_ts * 1000).toLocaleTimeString() : '—';
            return (
              <div className="perf-flow-row" key={i}>
                <div className="perf-flow-cell mono">{r.flow[0]}:{r.flow[1]}</div>
                <div className="perf-flow-cell mono">{r.flow[2]}:{r.flow[3]}</div>
                <div className="perf-flow-cell"><span className={"perf-tile-tag " + r.protocol}>{PROTO_LABEL[r.protocol] || r.protocol || '—'}</span></div>
                <div className="perf-flow-cell mono right">{fmtNum(r.packets)}</div>
                <div className="perf-flow-cell mono right">{fmtBytes(r.bytes)}</div>
                <div className="perf-flow-cell mono right">{fmtMs(r.latency_ms.mean)}</div>
                <div className="perf-flow-cell mono right">{fmtMs(r.latency_ms.p95)}</div>
                <div className="perf-flow-cell mono right">{fmtMs(r.latency_ms.p99)}</div>
                <div className="perf-flow-cell mono right">{fmtMs(r.latency_ms.max)}</div>
                <div className="perf-flow-cell mono">{last}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function EmptyChart({ label }) {
    return (
      <div className="perf-chart-empty">{label}</div>
    );
  }

  // ---- CSV export buttons ----
  function ExportBar({ onExport, busy, lastError }) {
    return (
      <div className="perf-export">
        <span className="perf-export-lbl">Export for analysis →</span>
        <button className="perf-export-btn" disabled={busy} onClick={() => onExport('csv_samples')}>
          latency samples (CSV)
        </button>
        <button className="perf-export-btn" disabled={busy} onClick={() => onExport('csv_per_flow')}>
          per-flow stats (CSV)
        </button>
        <button className="perf-export-btn" disabled={busy} onClick={() => onExport('csv_history')}>
          metrics history (CSV)
        </button>
        {busy && <span className="perf-export-status">exporting…</span>}
        {lastError && <span className="perf-export-status err">{lastError}</span>}
      </div>
    );
  }

  // ---- Latency stat tiles row ----
  function StatTilesRow({ perProto }) {
    return (
      <div className="perf-tiles">
        {PROTOS.map(p => {
          const block = perProto[p];
          return (
            <ProtoStatTile
              key={p}
              proto={p}
              lat={block?.latency_ms}
              iat={block?.iat_ms}
              size={block?.size_bytes}
              isEmpty={!block || block.latency_ms.n === 0}
            />
          );
        })}
      </div>
    );
  }

  // ---- Demo-mode synthetic perf snapshot from packets ----
  function synthFromPackets(packets) {
    const byProto = {}, byFlow = new Map();
    const ts = (Date.now() / 1000) - 5;
    for (const p of packets) {
      const proto = p.proto;
      const lat = p.latency || 0;
      const size = p.bytes?.length || 0;
      if (!byProto[proto]) byProto[proto] = { lats: [], iats: [], sizes: [], lastTs: null };
      const bp = byProto[proto];
      bp.lats.push(lat); bp.sizes.push(size);
      const t = p.ts / 1000;
      if (bp.lastTs != null) bp.iats.push((t - bp.lastTs) * 1000);
      bp.lastTs = t;

      const key = `${p.src}->${p.dst}`;
      const [src, sport] = p.src.split(':');
      const [dst, dport] = p.dst.split(':');
      let rec = byFlow.get(key);
      if (!rec) {
        rec = { flow: [src, parseInt(sport), dst, parseInt(dport)], protocol: proto,
                lats: [], bytes: 0, packets: 0, last_ts: 0 };
        byFlow.set(key, rec);
      }
      rec.lats.push(lat); rec.bytes += size; rec.packets += 1; rec.last_ts = t;
    }
    function summary(arr) {
      if (!arr.length) return { n: 0, n_total: 0, min: 0, max: 0, mean: 0, stddev: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
      const s = [...arr].sort((a, b) => a - b);
      const n = s.length;
      const mean = s.reduce((a, b) => a + b, 0) / n;
      const var_ = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
      const pick = (p) => s[Math.min(n - 1, Math.floor(n * p))];
      return { n, n_total: n, min: s[0], max: s[n - 1], mean, stddev: Math.sqrt(var_),
               p50: pick(0.5), p90: pick(0.9), p95: pick(0.95), p99: pick(0.99) };
    }
    const per_proto = {};
    for (const [proto, bp] of Object.entries(byProto)) {
      per_proto[proto] = {
        latency_ms: summary(bp.lats),
        iat_ms: summary(bp.iats),
        size_bytes: summary(bp.sizes),
        cdf: (() => {
          const s = [...bp.lats].sort((a, b) => a - b);
          if (!s.length) return [];
          return s.map((v, i) => [v, (i + 1) / s.length]).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 80)) === 0);
        })(),
      };
    }
    const per_flow = [...byFlow.values()].map(r => ({
      flow: r.flow, protocol: r.protocol,
      latency_ms: summary(r.lats), bytes: r.bytes, packets: r.packets, last_ts: r.last_ts,
    }));
    return { per_proto, per_flow, ts_series: {}, window_s: 300 };
  }

  // ---- main panel ----
  function PerformancePanel({ perf, packets, conn, demo, metricsSeries }) {
    const [busy, setBusy] = useState(false);
    const [lastError, setLastError] = useState(null);
    const dataRef = useRef(null);
    dataRef.current = perf;

    const data = (perf && perf.per_proto) ? perf : (demo ? synthFromPackets(packets) : null);
    const empty = !data || (Object.keys(data.per_proto || {}).length === 0 &&
                            (data.per_flow || []).length === 0);

    const onExport = async (kind) => {
      setBusy(true); setLastError(null);
      try {
        let csv = '', filename = `${kind}.csv`;
        if (demo || !conn || conn.state !== 'ok') {
          // Local fallback: synthesise a CSV from current UI state.
          if (kind === 'csv_samples') {
            csv = 'timestamp,protocol,latency_ms\n' +
              packets.filter(p => p.latency).map(p => `${(p.ts / 1000).toFixed(6)},${p.proto},${p.latency.toFixed(4)}`).join('\n') + '\n';
            filename = 'latency_samples.csv';
          } else if (kind === 'csv_per_flow') {
            const pf = synthFromPackets(packets).per_flow;
            csv = 'src_ip,src_port,dst_ip,dst_port,protocol,packets,bytes,latency_n,latency_min_ms,latency_mean_ms,latency_p50_ms,latency_p95_ms,latency_p99_ms,latency_max_ms,latency_stddev_ms,last_ts\n' +
              pf.map(r => {
                const f = r.flow, l = r.latency_ms;
                return `${f[0]},${f[1]},${f[2]},${f[3]},${r.protocol},${r.packets},${r.bytes},${l.n},${l.min.toFixed(4)},${l.mean.toFixed(4)},${l.p50.toFixed(4)},${l.p95.toFixed(4)},${l.p99.toFixed(4)},${l.max.toFixed(4)},${l.stddev.toFixed(4)},${r.last_ts.toFixed(6)}`;
              }).join('\n') + '\n';
            filename = 'per_flow_stats.csv';
          } else if (kind === 'csv_history') {
            csv = 'ts,bytes,msgs\n' +
              metricsSeries.map((m, i) => `${i},${m.bytes},${m.msgs}`).join('\n') + '\n';
            filename = 'metrics_history_demo.csv';
          }
        } else {
          const reply = await conn.query(kind, {}, 15000);
          csv = reply.data || '';
          filename = reply.filename || `${kind}.csv`;
        }
        downloadCsv(filename, csv);
      } catch (e) {
        setLastError(e.message || 'export failed');
      } finally {
        setBusy(false);
      }
    };

    if (empty) {
      return (
        <div className="perf-wrap">
          <div className="perf-empty">
            <b>No performance data yet.</b>
            <span>Waiting for the sniffer to push detailed metrics over WebSocket.</span>
            <span style={{ color:'var(--text-dim)', marginTop: 12 }}>
              Tip: open the Packet stream tab and verify frames are arriving.
            </span>
          </div>
          <ExportBar onExport={onExport} busy={busy} lastError={lastError}/>
        </div>
      );
    }

    return (
      <div className="perf-wrap">
        <ExportBar onExport={onExport} busy={busy} lastError={lastError}/>
        <StatTilesRow perProto={data.per_proto || {}}/>
        <div className="perf-charts-grid">
          <div className="perf-chart-card">
            <LatencyTimeSeriesChart tsSeries={data.ts_series || {}}/>
            <Legend protos={PROTOS} extra={[
              { label: 'p50', dash: '' },
              { label: 'p95', dash: '4 3' },
              { label: 'p99', dash: '1 3' },
            ]}/>
          </div>
          <div className="perf-chart-card">
            <LatencyCdfChart perProto={data.per_proto || {}}/>
            <Legend protos={PROTOS}/>
          </div>
        </div>
        <div className="perf-charts-grid">
          <div className="perf-chart-card">
            <IatChart perProto={data.per_proto || {}}/>
          </div>
          <div className="perf-chart-card">
            <SizeBarChart perProto={data.per_proto || {}}/>
          </div>
        </div>
        <PerFlowTable perFlow={data.per_flow || []}/>
      </div>
    );
  }

  function Legend({ protos, extra }) {
    return (
      <div className="perf-legend">
        {protos.map(p => (
          <span className="perf-legend-item" key={p}>
            <span className="perf-legend-swatch" style={{ background: PROTO_COLOR[p] }}></span>
            {PROTO_LABEL[p]}
          </span>
        ))}
        {extra && extra.map((e, i) => (
          <span className="perf-legend-item" key={'e' + i}>
            <svg width="22" height="6"><line x1="0" x2="22" y1="3" y2="3"
              stroke="oklch(0.66 0.012 240)" strokeWidth="1.6" strokeDasharray={e.dash || ''}/></svg>
            {e.label}
          </span>
        ))}
      </div>
    );
  }

  function downloadCsv(name, csv) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  window.PerformanceTab = PerformancePanel;
})();
