#!/usr/bin/env node
/**
 * DIAGNOSTIC: Monitors kline WebSocket events for all 11 Aegis canonical symbols.
 * Uses correct Binance futures URL: /market/ws/
 */
const { WebSocket } = require('ws');

const SYMBOLS = [
  'btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt',
  'dogeusdt', 'adausdt', 'avaxusdt', 'linkusdt', 'suiusdt', 'ltcusdt',
];
const INTERVAL = '5m';
const FRESHNESS_MS = 10_000;
const MONITOR_MS = 180_000; // 3 minutes
const REPORT_MS = 15_000;

const state = {};
for (const s of SYMBOLS) {
  state[s] = {
    symbol: s.toUpperCase(),
    events: 0,
    lastReceivedAt: null,
    lastEventTime: null,
    lastOpenTime: null,
    lastCloseTime: null,
    isClosed: false,
    lastAge: null,
    minAge: Infinity,
    maxAge: 0,
    gaps: 0,
    lastEventTs: null,
  };
}

// Correct URL: /market/ws/ for futures
const streams = SYMBOLS.map(s => `${s}@kline_${INTERVAL}`).join('/');
const url = `wss://fstream.binance.com/market/stream?streams=${streams}`;
console.log(`Connecting: ${url}`);

const ws = new WebSocket(url);
let msgCount = 0;
let connectedAt = null;

ws.on('open', () => {
  connectedAt = Date.now();
  console.log(`Connected at ${new Date(connectedAt).toISOString()}`);
});

ws.on('message', (raw) => {
  const now = Date.now();
  msgCount++;
  try {
    const msg = JSON.parse(raw.toString());
    const data = msg.data || msg;
    if (data.e === 'kline') {
      const k = data.k;
      const sym = (k.s || '').toLowerCase();
      if (!state[sym]) return;
      const s = state[sym];
      s.events++;
      s.lastReceivedAt = now;
      s.lastEventTime = data.E || null;
      s.lastOpenTime = k.t || null;
      s.isClosed = k.x || false;
      if (k.x) {
        s.lastCloseTime = k.t + 5 * 60 * 1000;
      }
      if (s.lastEventTs !== null) {
        const gap = data.E - s.lastEventTs;
        if (gap > 60_000) { // more than 60s between events = potential gap
          s.gaps++;
        }
      }
      s.lastEventTs = data.E;
      if (s.lastReceivedAt !== null && s.lastEventTime !== null) {
        const age = s.lastEventTime ? now - s.lastEventTime : null;
        s.lastAge = age;
        if (age !== null) {
          if (age < s.minAge) s.minAge = age;
          if (age > s.maxAge) s.maxAge = age;
        }
      }
    }
  } catch {}
});

ws.on('error', (err) => console.error('WS error:', err.message));
ws.on('close', (code, reason) => console.error(`WS closed: ${code} ${reason}`));

function report(now) {
  console.log(`\n${'='.repeat(90)}`);
  console.log(`REPORT @ ${new Date(now).toISOString()} (raw msgs: ${msgCount})`);
  console.log(`${'='.repeat(90)}`);
  console.log(
    'Symbol'.padEnd(12) +
    'Evts'.padStart(5) +
    'Age(ms)'.padStart(10) +
    'MinAge'.padStart(10) +
    'MaxAge'.padStart(10) +
    'Gaps'.padStart(5) +
    'Closed'.padStart(7) +
    'Status'
  );
  console.log('-'.repeat(90));
  for (const s of SYMBOLS) {
    const st = state[s];
    const age = st.lastReceivedAt ? now - st.lastReceivedAt : null;
    const ageStr = age !== null ? String(age) : 'N/A';
    const minStr = st.minAge !== Infinity ? String(st.minAge) : 'N/A';
    const maxStr = st.maxAge > 0 ? String(st.maxAge) : 'N/A';
    let status;
    if (st.events === 0) status = 'NO_EVENTS';
    else if (age !== null && age > FRESHNESS_MS) status = `STALE(${age}ms)`;
    else if (age !== null) status = `FRESH(${age}ms)`;
    else status = 'UNKNOWN';
    console.log(
      st.symbol.padEnd(12) +
      String(st.events).padStart(5) +
      ageStr.padStart(10) +
      minStr.padStart(10) +
      maxStr.padStart(10) +
      String(st.gaps).padStart(5) +
      (st.isClosed ? 'YES' : 'NO').padStart(7) +
      `  ${status}`
    );
  }
}

const reportTimer = setInterval(() => report(Date.now()), REPORT_MS);

setTimeout(() => {
  report(Date.now());
  console.log('\nDone.');
  clearInterval(reportTimer);
  ws.close();
  process.exit(0);
}, MONITOR_MS);
