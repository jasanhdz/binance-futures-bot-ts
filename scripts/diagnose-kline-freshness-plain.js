#!/usr/bin/env node
/**
 * DIAGNOSTIC: Raw Binance kline WebSocket monitoring.
 * Uses plain Node.js ws module for reliability.
 */
const { WebSocket } = require('ws');

const SYMBOLS = [
  'btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt',
  'dogeusdt', 'adausdt', 'avaxusdt', 'linkusdt', 'suiusdt', 'ltcusdt',
];
const INTERVAL = '5m';
const FRESHNESS_MS = 10_000;
const MONITOR_MS = 120_000;
const REPORT_MS = 15_000;

const state = {};
for (const s of SYMBOLS) {
  state[s] = {
    symbol: s.toUpperCase(),
    events: 0,
    lastReceivedAt: null,
    lastEventTime: null,
    lastOpenTime: null,
    isClosed: false,
    lastAge: null,
  };
}

// Use individual streams for reliability
const streams = SYMBOLS.map(s => `${s}@kline_${INTERVAL}`).join('/');
const url = `wss://fstream.binance.com/stream?streams=${streams}`;
console.log(`Connecting: ${url}`);

const ws = new WebSocket(url);
let msgCount = 0;

ws.on('open', () => {
  console.log(`Connected at ${new Date().toISOString()}`);
});

ws.on('message', (raw) => {
  const now = Date.now();
  msgCount++;
  try {
    const msg = JSON.parse(raw.toString());

    // Combined stream format: { stream: "...", data: {...} }
    const data = msg.data || msg;

    if (data.e === 'kline') {
      const k = data.k;
      const sym = (k.s || '').toLowerCase();
      if (!state[sym]) {
        console.log(`Unknown symbol: ${k.s}`);
        return;
      }
      const s = state[sym];
      s.events++;
      s.lastReceivedAt = now;
      s.lastEventTime = data.E || null;
      s.lastOpenTime = k.t || null;
      s.isClosed = k.x || false;
      s.lastAge = s.lastEventTime ? now - s.lastEventTime : null;
    } else if (msgCount <= 3) {
      // Log first few non-kline messages for debugging
      console.log(`Non-kline msg #${msgCount}:`, JSON.stringify(msg).slice(0, 200));
    }
  } catch (e) {
    if (msgCount <= 3) console.log(`Parse error: ${e.message}`);
  }
});

ws.on('error', (err) => {
  console.error('WS error:', err.message);
});

ws.on('close', (code, reason) => {
  console.error(`WS closed: ${code} ${reason}`);
});

function report(now) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`REPORT @ ${new Date(now).toISOString()} (raw messages: ${msgCount})`);
  console.log(`${'='.repeat(80)}`);
  console.log(
    'Symbol'.padEnd(12) +
    'Evts'.padStart(5) +
    'Age(ms)'.padStart(10) +
    'Closed'.padStart(7) +
    'OpenTime'.padStart(24) +
    'Status'
  );
  console.log('-'.repeat(80));
  for (const s of SYMBOLS) {
    const st = state[s];
    const age = st.lastReceivedAt ? now - st.lastReceivedAt : null;
    const ageStr = age !== null ? String(age) : 'N/A';
    const status = age === null ? 'NO_EVENTS' : age > FRESHNESS_MS ? `STALE_${age}ms` : 'FRESH';
    console.log(
      st.symbol.padEnd(12) +
      String(st.events).padStart(5) +
      ageStr.padStart(10) +
      (st.isClosed ? 'YES' : 'NO').padStart(7) +
      (st.lastOpenTime ? new Date(st.lastOpenTime).toISOString() : 'N/A').padStart(24) +
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
