// Performance / scientific analysis tab.
//
// Consumes `perf` snapshots pushed by the backend (one every ~5s) and the
// 1 Hz `metrics` stream piped in via props. The UI is intentionally dense:
// protocol comparison, charts, distributions, exports, and per-flow detail
// should all be visible without turning the dashboard into a report page.

(function () {
  const { useState, useMemo } = React;

  const PROTOS = ['modbus', 'mqtt-tcp', 'mqtt-ws'];
  const PROTO_LABEL = {
    'modbus': 'Modbus/TCP',
    'mqtt-tcp': 'MQTT/TCP',
    'mqtt-ws': 'MQTT/WS',
  };
  const PROTO_SHORT = {
    'modbus': 'Modbus',
    'mqtt-tcp': 'MQTT TCP',
    'mqtt-ws': 'MQTT WS',
  };
  const PROTO_COLOR = {
    'modbus': 'oklch(0.74 0.12 195)',
    'mqtt-tcp': 'oklch(0.80 0.14 75)',
    'mqtt-ws': 'oklch(0.74 0.14 25)',
  };

  const EMPTY_STATS = {
    n: 0, n_total: 0, min: 0, max: 0, mean: 0, stddev: 0,
    p50: 0, p90: 0, p95: 0, p99: 0,
  };

  function stats(s) {
    return { ...EMPTY_STATS, ...(s || {}) };
  }

  function fmtMs(v) {
    if (!Number.isFinite(v)) return '0.0';
    if (v < 1) return v.toFixed(3);
    if (v < 10) return v.toFixed(2);
    if (v < 1000) return v.toFixed(1);
    return v.toFixed(0);
  }

  function fmtNum(v) {
    if (v == null || !Number.isFinite(v)) return '0';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return Math.round(v).toLocaleString();
  }

  function fmtBytes(b) {
    if (!b || !Number.isFinite(b)) return '0 B';
    if (b < 1024) return `${Math.round(b)} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  }

  function fmtWindow(sec) {
    if (!sec || !Number.isFinite(sec)) return 'rolling window';
    if (sec < 90) return `${Math.round(sec)}s window`;
    return `${Math.round(sec / 60)}m window`;
  }

  function protoRows(perProto) {
    return PROTOS.map((proto) => {
      const block = perProto?.[proto] || {};
      return {
        proto,
        latency: stats(block.latency_ms),
        iat: stats(block.iat_ms),
        size: stats(block.size_bytes),
        cdf: block.cdf || [],
      };
    });
  }

  function latestObservedTs(data) {
    let latest = 0;
    Object.values(data?.ts_series || {}).forEach((buckets) => {
      (buckets || []).forEach((b) => { latest = Math.max(latest, b.ts || 0); });
    });
    (data?.per_flow || []).forEach((r) => { latest = Math.max(latest, r.last_ts || 0); });
    return latest;
  }

  function lastMetric(metricsSeries) {
    return (metricsSeries && metricsSeries[metricsSeries.length - 1]) || { bytes: 0, msgs: 0 };
  }

  function endpoint(flow, offset) {
    if (!flow) return '-';
    const ip = flow[offset] || '-';
    const port = flow[offset + 1] == null ? '-' : flow[offset + 1];
    return `${ip}:${port}`;
  }

  // ---- Generic line chart used by both time-series and CDF ----
  function LineChart({ width = 720, height = 220, padL = 44, padR = 14, padT = 8, padB = 28,
                      series, xLabel, yLabel, xDomain, yDomain, yLog = false,
                      xTickFmt, yTickFmt }) {
    const W = width, H = height;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const xs = [], ys = [];
    for (const s of series) {
      for (const p of s.points) {
        xs.push(p[0]);
        ys.push(p[1]);
      }
    }

    const xMin = xDomain ? xDomain[0] : (xs.length ? Math.min(...xs) : 0);
    const xMax = xDomain ? xDomain[1] : (xs.length ? Math.max(...xs) : 1);
    const yMin = yDomain ? yDomain[0] : 0;
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

    const yTickVals = Array.from({ length: 5 }, (_, i) => yMin + (yMax - yMin) * (i / 4));
    const xTickVals = Array.from({ length: 5 }, (_, i) => xMin + (xMax - xMin) * (i / 4));

    return (
      <svg className="perf-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {yTickVals.map((v, i) => (
          <g key={'y' + i}>
            <line x1={padL} x2={padL + plotW} y1={yScale(v)} y2={yScale(v)}
                  className="perf-chart-gridline"/>
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
        <line x1={padL} x2={padL + plotW} y1={padT + plotH} y2={padT + plotH}
              className="perf-chart-axis-line"/>
        <line x1={padL} x2={padL} y1={padT} y2={padT + plotH}
              className="perf-chart-axis-line"/>
        {yLabel && (
          <text x={8} y={padT + plotH / 2} className="perf-chart-axis"
                transform={`rotate(-90 8 ${padT + plotH / 2})`} textAnchor="middle">{yLabel}</text>
        )}
        {xLabel && (
          <text x={padL + plotW / 2} y={H - 1} className="perf-chart-axis" textAnchor="middle">{xLabel}</text>
        )}
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
              {s.points.length === 1 && (
                <circle cx={xScale(s.points[0][0])} cy={yScale(s.points[0][1])}
                        r="2.6" fill={s.color}/>
              )}
            </g>
          );
        })}
      </svg>
    );
  }

  function LatencyTimeSeriesChart({ tsSeries }) {
    const series = [];
    const allTs = [];
    let yMax = 1;
    for (const proto of PROTOS) {
      const buckets = tsSeries[proto] || [];
      if (!buckets.length) continue;
      const p50 = buckets.map(b => [b.ts, b.p50 || 0]);
      const p95 = buckets.map(b => [b.ts, b.p95 || 0]);
      const p99 = buckets.map(b => [b.ts, b.p99 || 0]);
      buckets.forEach((b) => {
        allTs.push(b.ts);
        yMax = Math.max(yMax, b.p99 || 0);
      });
      series.push({ points: p50, color: PROTO_COLOR[proto], width: 1.4 });
      series.push({ points: p95, color: PROTO_COLOR[proto], width: 1.4, dash: '4 3' });
      series.push({ points: p99, color: PROTO_COLOR[proto], width: 1.6, dash: '1 3' });
    }
    if (!series.length) return <EmptyChart label="waiting for latency buckets"/>;
    const xMin = Math.min(...allTs);
    const xMax = Math.max(...allTs);
    const xTickFmt = (t) => new Date(t * 1000).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    return (
      <LineChart
        series={series}
        xDomain={[xMin, xMax]} yDomain={[0, yMax * 1.12]}
        xLabel="time" yLabel="latency (ms)"
        xTickFmt={xTickFmt}
        yTickFmt={(v) => fmtMs(v)}
      />
    );
  }

  function LatencyCdfChart({ rows }) {
    const series = [];
    let xMax = 1;
    for (const row of rows) {
      if (!row.cdf.length) continue;
      row.cdf.forEach(p => { if (p[0] > xMax) xMax = p[0]; });
      series.push({
        points: row.cdf,
        color: PROTO_COLOR[row.proto],
        width: 1.7,
      });
    }
    if (!series.length) return <EmptyChart label="waiting for CDF samples"/>;
    return (
      <LineChart
        series={series}
        xDomain={[0, xMax * 1.05]} yDomain={[0, 1]}
        xLabel="latency (ms)" yLabel="P(X <= x)"
        xTickFmt={(v) => fmtMs(v)}
        yTickFmt={(v) => v.toFixed(1)}
      />
    );
  }

  function EmptyChart({ label }) {
    return <div className="perf-chart-empty">{label}</div>;
  }

  function ExportBar({ onExport, busy, lastError }) {
    const buttons = [
      ['csv_samples', 'Samples'],
      ['csv_per_flow', 'Flows'],
      ['csv_history', 'History'],
    ];
    return (
      <div className="perf-export">
        {buttons.map(([kind, label]) => (
          <button key={kind} className="perf-export-btn" disabled={busy} onClick={() => onExport(kind)}>
            {label}
          </button>
        ))}
        {busy && <span className="perf-export-status">exporting...</span>}
        {lastError && <span className="perf-export-status err">{lastError}</span>}
      </div>
    );
  }

  function PerformanceHeader({ data, rows, metricsSeries, demo, conn, onExport, busy, lastError }) {
    const latest = latestObservedTs(data);
    const connLabel = demo ? 'demo data' : conn?.state === 'ok' ? 'live socket' : 'local export mode';
    return (
      <div className="perf-head">
        <div className="perf-head-main">
          <div className="perf-eyebrow">Scientific performance analysis</div>
          <h2>Latency, jitter, and flow behavior</h2>
          <div className="perf-head-meta">
            <span>{fmtWindow(data?.window_s)}</span>
            <span>{connLabel}</span>
            <span>{latest ? `last sample ${new Date(latest * 1000).toLocaleTimeString()}` : 'waiting for samples'}</span>
          </div>
        </div>
        <ExportBar onExport={onExport} busy={busy} lastError={lastError}/>
      </div>
    );
  }

  function KpiStrip({ data, rows, metricsSeries }) {
    const flowCount = (data?.per_flow || []).length;
    const totalSamples = rows.reduce((sum, r) => sum + (r.latency.n_total || r.latency.n || 0), 0);
    const worstP95 = rows.reduce((best, r) => r.latency.p95 > best.value ? { proto: r.proto, value: r.latency.p95 } : best, { proto: null, value: 0 });
    const worstP99 = rows.reduce((best, r) => r.latency.p99 > best.value ? { proto: r.proto, value: r.latency.p99 } : best, { proto: null, value: 0 });
    const metric = lastMetric(metricsSeries);

    const cells = [
      { label: 'Latency samples', value: fmtNum(totalSamples), sub: 'all-time protocol matches' },
      { label: 'Worst p95', value: `${fmtMs(worstP95.value)} ms`, sub: worstP95.proto ? PROTO_LABEL[worstP95.proto] : 'no protocol yet' },
      { label: 'Worst p99', value: `${fmtMs(worstP99.value)} ms`, sub: worstP99.proto ? PROTO_LABEL[worstP99.proto] : 'no protocol yet' },
      { label: 'Active flows', value: fmtNum(flowCount), sub: `${fmtBytes(metric.bytes)}/s | ${fmtNum(metric.msgs)} msg/s` },
    ];

    return (
      <div className="perf-kpis">
        {cells.map((c) => (
          <div className="perf-kpi" key={c.label}>
            <span className="perf-kpi-label">{c.label}</span>
            <strong>{c.value}</strong>
            <span className="perf-kpi-sub">{c.sub}</span>
          </div>
        ))}
      </div>
    );
  }

  function ProtocolComparison({ rows }) {
    const maxP99 = Math.max(1, ...rows.map(r => r.latency.p99));
    return (
      <section className="perf-panel perf-protocol-panel">
        <PanelHead title="Protocol comparison" note="rolling latency window with inter-arrival and size context"/>
        <div className="perf-proto-list">
          {rows.map((r) => {
            const empty = (r.latency.n || r.latency.n_total) === 0;
            return (
              <div className={"perf-proto-row " + r.proto + (empty ? ' empty' : '')} key={r.proto}>
                <div className="perf-proto-id">
                  <span className={"perf-tag " + r.proto}>{PROTO_SHORT[r.proto]}</span>
                  <span>{fmtNum(r.latency.n || r.latency.n_total)} in window</span>
                </div>
                <div className="perf-proto-values">
                  <Metric label="mean" value={`${fmtMs(r.latency.mean)} ms`}/>
                  <Metric label="p50" value={`${fmtMs(r.latency.p50)} ms`}/>
                  <Metric label="p95" value={`${fmtMs(r.latency.p95)} ms`}/>
                  <Metric label="p99" value={`${fmtMs(r.latency.p99)} ms`}/>
                  <Metric label="std" value={`${fmtMs(r.latency.stddev)} ms`}/>
                </div>
                <div className="perf-proto-bar" aria-hidden="true">
                  <span className="bar mean" style={{ width: `${Math.min(100, (r.latency.mean / maxP99) * 100)}%`, background: PROTO_COLOR[r.proto] }}></span>
                  <span className="bar p95" style={{ width: `${Math.min(100, (r.latency.p95 / maxP99) * 100)}%`, background: PROTO_COLOR[r.proto] }}></span>
                  <span className="bar p99" style={{ width: `${Math.min(100, (r.latency.p99 / maxP99) * 100)}%`, background: PROTO_COLOR[r.proto] }}></span>
                </div>
                <div className="perf-proto-context">
                  <span>iat <b>{fmtMs(r.iat.mean)} ms</b></span>
                  <span>iat sd <b>{fmtMs(r.iat.stddev)} ms</b></span>
                  <span>size <b>{fmtNum(r.size.mean)} B</b></span>
                  <span>p95 <b>{fmtNum(r.size.p95)} B</b></span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  function Metric({ label, value }) {
    return (
      <span className="perf-metric">
        <span>{label}</span>
        <b>{value}</b>
      </span>
    );
  }

  function PanelHead({ title, note, children }) {
    return (
      <div className="perf-panel-head">
        <div>
          <h3>{title}</h3>
          {note && <p>{note}</p>}
        </div>
        {children}
      </div>
    );
  }

  function ChartPanel({ title, note, children, legend }) {
    return (
      <section className="perf-panel perf-chart-panel">
        <PanelHead title={title} note={note}/>
        {children}
        {legend}
      </section>
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
            <svg width="22" height="6" aria-hidden="true"><line x1="0" x2="22" y1="3" y2="3"
              stroke="oklch(0.66 0.012 240)" strokeWidth="1.6" strokeDasharray={e.dash || ''}/></svg>
            {e.label}
          </span>
        ))}
      </div>
    );
  }

  function IatPanel({ rows }) {
    const max = Math.max(1, ...rows.map(r => r.iat.max));
    return (
      <section className="perf-panel">
        <PanelHead title="Inter-arrival jitter" note="mean with one standard deviation band"/>
        <div className="perf-range-list">
          {rows.map((r) => {
            const left = Math.max(0, r.iat.mean - r.iat.stddev);
            const right = Math.min(max, r.iat.mean + r.iat.stddev);
            return (
              <div className="perf-range-row" key={r.proto}>
                <div className="perf-range-name"><span className={"perf-tag " + r.proto}>{PROTO_SHORT[r.proto]}</span></div>
                <div className="perf-range-track">
                  <span className="range-fill" style={{ width: `${(r.iat.mean / max) * 100}%`, background: PROTO_COLOR[r.proto] }}></span>
                  <span className="range-band" style={{ left: `${(left / max) * 100}%`, width: `${((right - left) / max) * 100}%` }}></span>
                </div>
                <div className="perf-range-values">
                  <span>mean <b>{fmtMs(r.iat.mean)} ms</b></span>
                  <span>std <b>{fmtMs(r.iat.stddev)} ms</b></span>
                  <span>max <b>{fmtMs(r.iat.max)} ms</b></span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  function SizePanel({ rows }) {
    const max = Math.max(1, ...rows.map(r => r.size.max));
    return (
      <section className="perf-panel">
        <PanelHead title="Frame size distribution" note="p95 fill with mean and median markers"/>
        <div className="perf-range-list">
          {rows.map((r) => (
            <div className="perf-range-row" key={r.proto}>
              <div className="perf-range-name"><span className={"perf-tag " + r.proto}>{PROTO_SHORT[r.proto]}</span></div>
              <div className="perf-range-track">
                <span className="range-fill" style={{ width: `${(r.size.p95 / max) * 100}%`, background: PROTO_COLOR[r.proto] }}></span>
                <span className="range-tick mean" style={{ left: `${(r.size.mean / max) * 100}%` }} title={`mean ${fmtNum(r.size.mean)} B`}></span>
                <span className="range-tick median" style={{ left: `${(r.size.p50 / max) * 100}%` }} title={`p50 ${fmtNum(r.size.p50)} B`}></span>
              </div>
              <div className="perf-range-values">
                <span>mean <b>{fmtNum(r.size.mean)} B</b></span>
                <span>p50 <b>{fmtNum(r.size.p50)} B</b></span>
                <span>p95 <b>{fmtNum(r.size.p95)} B</b></span>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  function PerFlowTable({ perFlow }) {
    const [sort, setSort] = useState({ key: 'p99', dir: 'desc' });
    const sorted = useMemo(() => {
      const rows = [...perFlow];
      const get = (r) => {
        const lat = stats(r.latency_ms);
        switch (sort.key) {
          case 'src':      return endpoint(r.flow, 0);
          case 'dst':      return endpoint(r.flow, 2);
          case 'protocol': return r.protocol || '';
          case 'packets':  return r.packets || 0;
          case 'bytes':    return r.bytes || 0;
          case 'mean':     return lat.mean;
          case 'p95':      return lat.p95;
          case 'p99':      return lat.p99;
          case 'max':      return lat.max;
          case 'last':     return r.last_ts || 0;
          default:         return 0;
        }
      };
      rows.sort((a, b) => {
        const av = get(a), bv = get(b);
        if (av < bv) return sort.dir === 'asc' ? -1 : 1;
        if (av > bv) return sort.dir === 'asc' ? 1 : -1;
        return 0;
      });
      return rows;
    }, [perFlow, sort]);

    const head = [
      ['src', 'Source'], ['dst', 'Destination'], ['protocol', 'Proto'],
      ['packets', 'Pkts'], ['bytes', 'Bytes'],
      ['mean', 'Mean'], ['p95', 'P95'], ['p99', 'P99'], ['max', 'Max'],
      ['last', 'Last seen'],
    ];

    const toggleSort = (key) => {
      setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
    };

    return (
      <section className="perf-panel perf-flow-table">
        <PanelHead title="Flow ledger" note={`${sorted.length} active flows, sorted by tail latency by default`}/>
        <div className="perf-flow-scroll">
          <div className="perf-flow-grid perf-flow-head">
            {head.map(([k, label]) => (
              <button key={k} className={"perf-flow-cell " + (sort.key === k ? 'sort-' + sort.dir : '')}
                      onClick={() => toggleSort(k)}>
                {label}
                {sort.key === k && <span className="perf-flow-arrow">{sort.dir === 'asc' ? 'up' : 'down'}</span>}
              </button>
            ))}
          </div>
          <div className="perf-flow-body">
            {sorted.length === 0 && <div className="perf-flow-empty">no flows yet - waiting for capture</div>}
            {sorted.map((r, i) => {
              const lat = stats(r.latency_ms);
              const last = r.last_ts ? new Date(r.last_ts * 1000).toLocaleTimeString() : '-';
              return (
                <div className="perf-flow-grid perf-flow-row" key={`${endpoint(r.flow, 0)}-${endpoint(r.flow, 2)}-${i}`}>
                  <div className="perf-flow-cell mono">{endpoint(r.flow, 0)}</div>
                  <div className="perf-flow-cell mono">{endpoint(r.flow, 2)}</div>
                  <div className="perf-flow-cell"><span className={"perf-tag " + r.protocol}>{PROTO_SHORT[r.protocol] || r.protocol || '-'}</span></div>
                  <div className="perf-flow-cell mono right">{fmtNum(r.packets)}</div>
                  <div className="perf-flow-cell mono right">{fmtBytes(r.bytes)}</div>
                  <div className="perf-flow-cell mono right">{fmtMs(lat.mean)}</div>
                  <div className="perf-flow-cell mono right">{fmtMs(lat.p95)}</div>
                  <div className="perf-flow-cell mono right">{fmtMs(lat.p99)}</div>
                  <div className="perf-flow-cell mono right">{fmtMs(lat.max)}</div>
                  <div className="perf-flow-cell mono">{last}</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    );
  }

  // ---- Demo-mode synthetic perf snapshot from packets ----
  function synthFromPackets(packets) {
    const byProto = {}, byFlow = new Map();
    for (const p of packets) {
      const proto = p.proto;
      const lat = Number.isFinite(p.latency) ? p.latency : 0;
      const size = p.bytes?.length || 0;
      if (!byProto[proto]) byProto[proto] = { lats: [], iats: [], sizes: [], lastTs: null };
      const bp = byProto[proto];
      bp.lats.push(lat);
      bp.sizes.push(size);
      const t = p.ts / 1000;
      if (bp.lastTs != null) bp.iats.push((t - bp.lastTs) * 1000);
      bp.lastTs = t;

      const key = `${p.src}->${p.dst}`;
      const [src, sport] = p.src.split(':');
      const [dst, dport] = p.dst.split(':');
      let rec = byFlow.get(key);
      if (!rec) {
        rec = {
          flow: [src, parseInt(sport), dst, parseInt(dport)], protocol: proto,
          lats: [], bytes: 0, packets: 0, last_ts: 0,
        };
        byFlow.set(key, rec);
      }
      rec.lats.push(lat);
      rec.bytes += size;
      rec.packets += 1;
      rec.last_ts = t;
    }

    function summary(arr) {
      if (!arr.length) return { ...EMPTY_STATS };
      const s = [...arr].sort((a, b) => a - b);
      const n = s.length;
      const mean = s.reduce((a, b) => a + b, 0) / n;
      const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
      const pick = (p) => s[Math.min(n - 1, Math.floor(n * p))];
      return {
        n, n_total: n, min: s[0], max: s[n - 1], mean, stddev: Math.sqrt(variance),
        p50: pick(0.5), p90: pick(0.9), p95: pick(0.95), p99: pick(0.99),
      };
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
          const step = Math.max(1, Math.floor(s.length / 80));
          const out = s.map((v, i) => [v, (i + 1) / s.length]).filter((_, i) => i % step === 0);
          if (out.length && out[out.length - 1][1] < 1) out.push([s[s.length - 1], 1]);
          return out;
        })(),
      };
    }

    const per_flow = [...byFlow.values()].map(r => ({
      flow: r.flow, protocol: r.protocol,
      latency_ms: summary(r.lats), bytes: r.bytes, packets: r.packets, last_ts: r.last_ts,
    }));

    const ts_series = {};
    for (const [proto, bp] of Object.entries(byProto)) {
      if (!bp.lats.length || bp.lastTs == null) continue;
      ts_series[proto] = [{ ts: bp.lastTs, n: bp.lats.length, ...summary(bp.lats) }];
    }
    return { per_proto, per_flow, ts_series, window_s: 300 };
  }

  function PerformancePanel({ perf, packets, conn, demo, metricsSeries }) {
    const [busy, setBusy] = useState(false);
    const [lastError, setLastError] = useState(null);
    const data = (perf && perf.per_proto) ? perf : (demo ? synthFromPackets(packets) : null);
    const rows = useMemo(() => protoRows(data?.per_proto || {}), [data]);
    const empty = !data || (Object.keys(data.per_proto || {}).length === 0 &&
                            (data.per_flow || []).length === 0);

    const onExport = async (kind) => {
      setBusy(true);
      setLastError(null);
      try {
        let csv = '', filename = `${kind}.csv`;
        if (demo || !conn || conn.state !== 'ok') {
          const synth = synthFromPackets(packets);
          if (kind === 'csv_samples') {
            csv = 'timestamp,protocol,latency_ms\n' +
              packets
                .filter(p => Number.isFinite(p.latency))
                .map(p => `${(p.ts / 1000).toFixed(6)},${p.proto},${p.latency.toFixed(4)}`)
                .join('\n') + '\n';
            filename = 'latency_samples.csv';
          } else if (kind === 'csv_per_flow') {
            csv = 'src_ip,src_port,dst_ip,dst_port,protocol,packets,bytes,latency_n,latency_min_ms,latency_mean_ms,latency_p50_ms,latency_p95_ms,latency_p99_ms,latency_max_ms,latency_stddev_ms,last_ts\n' +
              synth.per_flow.map(r => {
                const f = r.flow, l = stats(r.latency_ms);
                return `${f[0]},${f[1]},${f[2]},${f[3]},${r.protocol},${r.packets},${r.bytes},${l.n},${l.min.toFixed(4)},${l.mean.toFixed(4)},${l.p50.toFixed(4)},${l.p95.toFixed(4)},${l.p99.toFixed(4)},${l.max.toFixed(4)},${l.stddev.toFixed(4)},${r.last_ts.toFixed(6)}`;
              }).join('\n') + '\n';
            filename = 'per_flow_stats.csv';
          } else if (kind === 'csv_history') {
            csv = 'ts,bytes,msgs\n' +
              (metricsSeries || []).map((m, i) => `${i},${m.bytes},${m.msgs}`).join('\n') + '\n';
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
          <PerformanceHeader
            data={data || { window_s: 300 }} rows={rows} metricsSeries={metricsSeries || []}
            demo={demo} conn={conn} onExport={onExport} busy={busy} lastError={lastError}
          />
          <div className="perf-empty">
            <b>No performance data yet.</b>
            <span>Waiting for latency samples from the sniffer WebSocket.</span>
            <span>Open Packet stream to confirm frames are arriving.</span>
          </div>
        </div>
      );
    }

    return (
      <div className="perf-wrap">
        <PerformanceHeader
          data={data} rows={rows} metricsSeries={metricsSeries || []}
          demo={demo} conn={conn} onExport={onExport} busy={busy} lastError={lastError}
        />
        <KpiStrip data={data} rows={rows} metricsSeries={metricsSeries || []}/>
        <ProtocolComparison rows={rows}/>
        <div className="perf-grid two">
          <ChartPanel
            title="Latency over time"
            note="p50 solid, p95 dashed, p99 dotted across 5 second buckets"
            legend={<Legend protos={PROTOS} extra={[
              { label: 'p50', dash: '' },
              { label: 'p95', dash: '4 3' },
              { label: 'p99', dash: '1 3' },
            ]}/>}
          >
            <LatencyTimeSeriesChart tsSeries={data.ts_series || {}}/>
          </ChartPanel>
          <ChartPanel
            title="Latency CDF"
            note="cumulative probability by protocol"
            legend={<Legend protos={PROTOS}/>}
          >
            <LatencyCdfChart rows={rows}/>
          </ChartPanel>
        </div>
        <div className="perf-grid two compact">
          <IatPanel rows={rows}/>
          <SizePanel rows={rows}/>
        </div>
        <PerFlowTable perFlow={data.per_flow || []}/>
      </div>
    );
  }

  function downloadCsv(name, csv) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  window.PerformanceTab = PerformancePanel;
})();
