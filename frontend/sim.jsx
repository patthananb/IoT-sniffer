// Packet synthesizer used when backend is unreachable. Identical shape to
// what `live.jsx` produces. Activate by appending `?demo=1` to the URL.

const HOSTS = {
  plc:     ['10.0.14.12', '10.0.14.18', '10.0.14.23', '10.0.14.31'],
  hmi:     ['10.0.8.4', '10.0.8.5'],
  scada:   ['10.0.2.10'],
  broker:  ['10.0.4.20'],
  gateway: ['10.0.4.21'],
  sensor:  ['192.168.40.112', '192.168.40.118', '192.168.40.125', '192.168.40.134', '192.168.40.141'],
  edge:    ['172.19.3.7', '172.19.3.9'],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.random() * (max - min) + min;
const randi = (min, max) => Math.floor(rand(min, max));
const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

const MODBUS_FC = {
  0x01: 'Read Coils', 0x02: 'Read Discrete Inputs',
  0x03: 'Read Holding Registers', 0x04: 'Read Input Registers',
  0x05: 'Write Single Coil', 0x06: 'Write Single Register',
  0x0F: 'Write Multiple Coils', 0x10: 'Write Multiple Registers',
};
const MODBUS_EXC = {
  0x01: 'ILLEGAL FUNCTION', 0x02: 'ILLEGAL DATA ADDRESS',
  0x03: 'ILLEGAL DATA VALUE', 0x04: 'SLAVE DEVICE FAILURE',
  0x06: 'SLAVE DEVICE BUSY',
};
const MQTT_TYPES = {
  1: 'CONNECT', 2: 'CONNACK', 3: 'PUBLISH', 4: 'PUBACK',
  8: 'SUBSCRIBE', 9: 'SUBACK', 12: 'PINGREQ', 13: 'PINGRESP', 14: 'DISCONNECT',
};
const TOPICS = [
  'factory/line1/temp', 'factory/line1/vibration', 'factory/line2/pressure',
  'plant/hvac/setpoint', 'plant/hvac/actual', 'sensors/flow/meter07',
  'sensors/tank/level', 'devices/robot/arm3/pos', 'devices/robot/arm3/state',
  'alerts/threshold/breach',
];

let TXID = 0x4C10;
let MQTT_PKT = 1;

function synthModbus() {
  const isException = Math.random() < 0.07;
  const src = Math.random() < 0.5 ? pick(HOSTS.hmi) : pick(HOSTS.scada);
  const dst = pick(HOSTS.plc);
  const fcCode = isException ? pick([0x03, 0x04, 0x10, 0x06]) : pick([0x03, 0x03, 0x03, 0x04, 0x06, 0x10, 0x01]);
  const fcName = MODBUS_FC[fcCode] || `FC${fcCode}`;
  const isResp = Math.random() < 0.5;
  const txid = TXID++;
  const unit = pick([1, 1, 2, 3, 17]);
  const startAddr = randi(0, 0xFFFF);
  const qty = isResp && (fcCode === 0x03 || fcCode === 0x04) ? randi(2, 20) : randi(1, 32);

  let bytes = [];
  bytes.push((txid >> 8) & 0xFF, txid & 0xFF);
  bytes.push(0x00, 0x00);
  const lenPos = bytes.length;
  bytes.push(0x00, 0x00);
  bytes.push(unit);
  bytes.push(fcCode | (isException ? 0x80 : 0x00));
  const fieldMap = [
    { name: 'Transaction ID', desc: 'MBAP header', bytes: [0,1], value: `0x${hex(txid,4)}`, group: 0 },
    { name: 'Protocol ID', desc: 'MBAP header', bytes: [2,3], value: '0x0000 (Modbus)', group: 0 },
    { name: 'Length', desc: 'MBAP header', bytes: [4,5], value: '—', group: 0 },
    { name: 'Unit Identifier', desc: 'MBAP header', bytes: [6], value: `${unit}`, group: 0 },
    { name: 'Function Code', desc: isException ? 'PDU (exception)' : 'PDU', bytes: [7],
      value: isException ? `0x${hex(fcCode|0x80)} (${fcName})` : `0x${hex(fcCode)} (${fcName})`,
      group: isException ? 5 : 0 },
  ];

  let summary, exceptionCode = null;
  if (isException) {
    exceptionCode = pick([0x01, 0x02, 0x03, 0x04, 0x06]);
    bytes.push(exceptionCode);
    fieldMap.push({ name: 'Exception Code', desc: 'PDU', bytes: [8], value: `0x${hex(exceptionCode)} ${MODBUS_EXC[exceptionCode]}`, group: 5 });
    summary = `unit=${unit} fc=${fcCode} → ${MODBUS_EXC[exceptionCode]}`;
  } else if (!isResp) {
    bytes.push((startAddr >> 8) & 0xFF, startAddr & 0xFF);
    bytes.push((qty >> 8) & 0xFF, qty & 0xFF);
    fieldMap.push(
      { name: 'Starting Address', desc: 'PDU', bytes: [8,9], value: `0x${hex(startAddr,4)} (${startAddr})`, group: 3 },
      { name: 'Quantity', desc: 'PDU', bytes: [10,11], value: `${qty}`, group: 3 },
    );
    summary = `unit=${unit} addr=0x${hex(startAddr,4)} qty=${qty}`;
  } else {
    if (fcCode === 0x03 || fcCode === 0x04) {
      const byteCount = qty * 2;
      bytes.push(byteCount);
      const valStart = bytes.length;
      const vals = [];
      for (let i = 0; i < qty; i++) {
        const v = randi(0, 0xFFFF);
        vals.push(v);
        bytes.push((v >> 8) & 0xFF, v & 0xFF);
      }
      fieldMap.push(
        { name: 'Byte Count', desc: 'PDU', bytes: [8], value: `${byteCount}`, group: 3 },
        { name: 'Register Values', desc: `${qty} × uint16`,
          bytes: Array.from({length: byteCount}, (_, i) => valStart + i),
          value: vals.slice(0, 3).join(', ') + (vals.length > 3 ? ', …' : ''),
          group: 4 },
      );
      summary = `unit=${unit} ${qty} regs = [${vals.slice(0,3).join(', ')}${vals.length > 3 ? ', …' : ''}]`;
    } else if (fcCode === 0x06 || fcCode === 0x05) {
      bytes.push((startAddr >> 8) & 0xFF, startAddr & 0xFF);
      const val = randi(0, 0xFFFF);
      bytes.push((val >> 8) & 0xFF, val & 0xFF);
      fieldMap.push(
        { name: 'Address', desc: 'PDU', bytes: [8,9], value: `0x${hex(startAddr,4)}`, group: 3 },
        { name: 'Value', desc: 'PDU', bytes: [10,11], value: `${val}`, group: 4 },
      );
      summary = `unit=${unit} addr=0x${hex(startAddr,4)} ← ${val}`;
    } else {
      bytes.push((startAddr >> 8) & 0xFF, startAddr & 0xFF);
      bytes.push((qty >> 8) & 0xFF, qty & 0xFF);
      fieldMap.push(
        { name: 'Address', desc: 'PDU', bytes: [8,9], value: `0x${hex(startAddr,4)}`, group: 3 },
        { name: 'Quantity', desc: 'PDU', bytes: [10,11], value: `${qty}`, group: 3 },
      );
      summary = `unit=${unit} addr=0x${hex(startAddr,4)} qty=${qty} ack`;
    }
  }
  const length = bytes.length - 6;
  bytes[lenPos] = (length >> 8) & 0xFF;
  bytes[lenPos+1] = length & 0xFF;
  fieldMap.find(f => f.name === 'Length').value = `${length}`;

  const latency = isException ? rand(8, 30) : rand(1.2, 14);
  return {
    proto: 'modbus', protoLabel: 'Modbus/TCP',
    src: `${src}:${randi(40000, 60000)}`, dst: `${dst}:502`,
    type: isException ? 'Exception' : (isResp ? `${fcName} resp` : `${fcName}`),
    summary, latency, isError: isException,
    bytes, fieldMap,
    meta: { 'Unit': unit, 'TxID': `0x${hex(txid, 4)}`, 'Length': length },
  };
}

function synthMqtt(kind) {
  const type = pick([3, 3, 3, 3, 3, 4, 1, 2, 8, 9, 12, 13]);
  const isPub = type === 3;
  const topic = pick(TOPICS);
  const pktId = MQTT_PKT++;
  const src = Math.random() < 0.5 ? pick(HOSTS.sensor) : pick(HOSTS.edge);
  const dst = kind === 'tcp' ? pick(HOSTS.broker) : pick(HOSTS.gateway);
  const qos = isPub ? pick([0, 0, 0, 1, 1, 2]) : 0;
  const retain = isPub && Math.random() < 0.15;
  const payload = isPub ? genPayload(topic) : '';

  let bytes = [];
  const fieldMap = [];
  const hdr = (type << 4) | ((qos & 3) << 1) | (retain ? 1 : 0);
  bytes.push(hdr);
  fieldMap.push({ name: 'Fixed Header', desc: `Type=${MQTT_TYPES[type]} QoS=${qos}${retain ? ' RETAIN' : ''}`,
    bytes: [0], value: `0x${hex(hdr)}`, group: 0 });

  const lenPos = bytes.length;
  bytes.push(0);

  if (type === 3) {
    const tLen = topic.length;
    const startT = bytes.length;
    bytes.push((tLen >> 8) & 0xFF, tLen & 0xFF);
    for (const ch of topic) bytes.push(ch.charCodeAt(0));
    fieldMap.push({ name: 'Topic Length', desc: 'Variable header', bytes: [startT, startT+1], value: `${tLen}`, group: 1 });
    fieldMap.push({ name: 'Topic', desc: 'Variable header',
      bytes: Array.from({length: tLen}, (_, i) => startT + 2 + i), value: topic, group: 2 });
    if (qos > 0) {
      const pidPos = bytes.length;
      bytes.push((pktId >> 8) & 0xFF, pktId & 0xFF);
      fieldMap.push({ name: 'Packet ID', desc: 'Variable header', bytes: [pidPos, pidPos+1], value: `${pktId}`, group: 1 });
    }
    const payStart = bytes.length;
    for (const ch of payload) bytes.push(ch.charCodeAt(0));
    fieldMap.push({ name: 'Payload', desc: `${payload.length} bytes`,
      bytes: Array.from({length: payload.length}, (_, i) => payStart + i),
      value: payload.length > 22 ? payload.slice(0, 22) + '…' : payload, group: 3 });
  } else if (type === 1) {
    const proto = 'MQTT';
    const startP = bytes.length;
    bytes.push(0x00, 0x04, ...proto.split('').map(c => c.charCodeAt(0)));
    bytes.push(0x04); bytes.push(0x02); bytes.push(0x00, 0x3C);
    const clientId = `edge-${pick(['A','B','C'])}${randi(100,999)}`;
    bytes.push(0x00, clientId.length, ...clientId.split('').map(c => c.charCodeAt(0)));
    fieldMap.push(
      { name: 'Protocol Name', desc: 'Variable header', bytes: [startP, startP+1, startP+2, startP+3, startP+4, startP+5], value: `"MQTT"`, group: 1 },
      { name: 'Protocol Level', desc: 'Variable header', bytes: [startP+6], value: '4 (v3.1.1)', group: 1 },
      { name: 'Connect Flags', desc: 'Variable header', bytes: [startP+7], value: 'CleanSession', group: 1 },
      { name: 'Keep Alive', desc: 'Variable header', bytes: [startP+8, startP+9], value: '60 s', group: 1 },
      { name: 'Client ID', desc: 'Payload', bytes: Array.from({length: clientId.length+2}, (_, i) => startP+10+i), value: `"${clientId}"`, group: 2 },
    );
  } else if (type === 2) {
    bytes.push(0x00, 0x00);
    fieldMap.push(
      { name: 'Ack Flags', desc: 'Variable header', bytes: [2], value: '0x00', group: 1 },
      { name: 'Reason Code', desc: 'Variable header', bytes: [3], value: '0x00 (accepted)', group: 1 },
    );
  } else if (type === 4 || type === 9) {
    bytes.push((pktId >> 8) & 0xFF, pktId & 0xFF);
    fieldMap.push({ name: 'Packet ID', desc: 'Variable header', bytes: [2,3], value: `${pktId}`, group: 1 });
    if (type === 9) {
      bytes.push(0x01);
      fieldMap.push({ name: 'Granted QoS', desc: 'Payload', bytes: [4], value: '1', group: 2 });
    }
  } else if (type === 8) {
    bytes.push((pktId >> 8) & 0xFF, pktId & 0xFF);
    fieldMap.push({ name: 'Packet ID', desc: 'Variable header', bytes: [2,3], value: `${pktId}`, group: 1 });
    const tLen = topic.length;
    bytes.push((tLen >> 8) & 0xFF, tLen & 0xFF);
    for (const ch of topic) bytes.push(ch.charCodeAt(0));
    bytes.push(0x01);
    fieldMap.push(
      { name: 'Topic Filter', desc: 'Payload', bytes: Array.from({length: tLen+2}, (_, i) => 4+i), value: `"${topic}"`, group: 2 },
      { name: 'Requested QoS', desc: 'Payload', bytes: [4+2+tLen], value: '1', group: 2 },
    );
  }
  bytes[lenPos] = bytes.length - 2;
  const remLen = bytes.length - 2;
  fieldMap.splice(1, 0, { name: 'Remaining Length', desc: 'Fixed header', bytes: [1], value: `${remLen}`, group: 0 });

  let summary;
  if (type === 3) summary = `${topic} ← ${payload.length > 24 ? payload.slice(0,24)+'…' : payload}`;
  else if (type === 8) summary = `subscribe ${topic} qos=1`;
  else if (type === 1) summary = `connect v3.1.1 ka=60`;
  else if (type === 2) summary = `connection accepted`;
  else if (type === 12) summary = `ping →`;
  else if (type === 13) summary = `← pong`;
  else if (type === 4) summary = `ack pid=${pktId}`;
  else if (type === 9) summary = `subscribe ack pid=${pktId}`;
  else summary = MQTT_TYPES[type].toLowerCase();

  const meta = { 'Type': MQTT_TYPES[type], 'QoS': qos, 'Retain': retain ? 'yes' : 'no', 'Length': remLen + 2 };
  if (type === 3 || type === 8) meta.Topic = topic;

  return {
    proto: kind === 'tcp' ? 'mqtt-tcp' : 'mqtt-ws',
    protoLabel: kind === 'tcp' ? 'MQTT/TCP' : 'MQTT/WS',
    src: `${src}:${randi(40000, 60000)}`,
    dst: kind === 'tcp' ? `${dst}:1883` : `${dst}:8083`,
    type: MQTT_TYPES[type], summary,
    latency: rand(1.5, 18), isError: false,
    bytes, fieldMap,
    meta,
  };
}

function genPayload(topic) {
  if (topic.includes('temp')) return `{"t":${rand(22, 78).toFixed(2)},"u":"C"}`;
  if (topic.includes('vibration')) return `{"rms":${rand(0.2, 4.8).toFixed(3)},"pk":${rand(1, 12).toFixed(2)}}`;
  if (topic.includes('pressure')) return `{"p":${rand(1.0, 9.5).toFixed(2)},"u":"bar"}`;
  if (topic.includes('flow')) return `{"q":${rand(0, 120).toFixed(1)},"tot":${randi(10000,99999)}}`;
  if (topic.includes('level')) return `{"lvl":${(rand(0,1)).toFixed(3)}}`;
  if (topic.includes('pos')) return `{"x":${rand(-180,180).toFixed(1)},"y":${rand(-180,180).toFixed(1)},"z":${rand(0,90).toFixed(1)}}`;
  if (topic.includes('state')) return pick(['"IDLE"','"RUN"','"HOLD"','"FAULT"']);
  if (topic.includes('setpoint')) return `${rand(18,26).toFixed(1)}`;
  if (topic.includes('actual')) return `${rand(17,27).toFixed(2)}`;
  if (topic.includes('alerts')) return `{"sev":"warn","code":${randi(100,999)}}`;
  return `${rand(0,100).toFixed(2)}`;
}

function synthPacket(enabledProtos) {
  const pool = [];
  if (enabledProtos.has('modbus')) pool.push('modbus','modbus','modbus');
  if (enabledProtos.has('mqtt-tcp')) pool.push('mqtt-tcp','mqtt-tcp');
  if (enabledProtos.has('mqtt-ws')) pool.push('mqtt-ws');
  if (pool.length === 0) return null;
  const kind = pick(pool);
  if (kind === 'modbus') return synthModbus();
  if (kind === 'mqtt-tcp') return synthMqtt('tcp');
  return synthMqtt('ws');
}

function seedInitialPackets(n, enabledProtos) {
  const out = [];
  const now = Date.now();
  for (let i = n; i > 0; i--) {
    const p = synthPacket(enabledProtos);
    if (!p) continue;
    out.push({ ...p, id: now - i * 120 + Math.random(), ts: now - i * 120 });
  }
  return out;
}

window.Sim = { synthPacket, seedInitialPackets };
