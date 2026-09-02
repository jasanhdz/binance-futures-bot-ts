#!/usr/bin/env node
/**
 * DIAGNOSTIC: Monitors kline WebSocket events for all 11 Aegis canonical symbols.
 * Identifies exactly why any symbol appears STALE.
 *
 * Usage: npx tsx scripts/diagnose-kline-freshness.ts
 */
import WebSocket from 'ws';

const SYMBOLS = [
  'btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt',
  'dogeusdt', 'adausdt', 'avaxusdt', 'linkusdt', 'suiusdt', 'ltcusdt',
];
const INTERVAL = '5m';
const FRESHNESS_MS = 10_000;
const MONITOR_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const REPORT_INTERVAL_MS = 15_000;

interface SymbolState {
  symbol: string;
  lastKlineEventAtMs: number | null;
  lastKlineReceivedAtMs: number | null;
  klineEventCount: number;
  lastOpenTime: number | null;
  lastCloseTime: number | null;
  isClosed: boolean;
  lastAgeMs: number | null;
  staleReasons: string[];
}

const states = new Map<string, SymbolState>();

function initState(symbol: string): SymbolState {
  return {
    symbol: symbol.toUpperCase(),
    lastKlineEventAtMs: null,
    lastKlineReceivedAtMs: null,
    klineEventCount: 0,
    lastOpenTime: null,
    lastCloseTime: null,
    isClosed: false,
    lastAgeMs: null,
    staleReasons: [],
  };
}

function analyzeFreshness(state: SymbolState, now: number): string {
  const reasons: string[] = [];
  if (state.klineEventCount === 0) {
    reasons.push('NO_KLINE_EVENTS');
    return reasons.join('; ');
  }
  if (state.lastKlineReceivedAtMs === null) {
    reasons.push('NO_RECEIVED_AT');
    return reasons.join('; ');
  }
  const ageMs = now - state.lastKlineReceivedAtMs;
  state.lastAgeMs = ageMs;
  if (ageMs > FRESHNESS_MS) {
    reasons.push(`CAUSALLY_STALE: age=${ageMs}ms > threshold=${FRESHNESS_MS}ms`);
  }
  if (!state.isClosed) {
    reasons.push('CURRENT_CANDLE_OPEN_NOT_CLOSED');
  }
  if (state.staleReasons.length > 0) {
    reasons.push(...state.staleReasons);
  }
  return reasons.length > 0 ? reasons.join('; ') : 'OK';
}

function formatReport(now: number): string {
  const lines: string[] = [];
  lines.push(`\n${'='.repeat(70)}`);
  lines.push(`DIAGNOSTIC REPORT @ ${new Date(now).toISOString()}`);
  lines.push(`${'='.repeat(70)}`);
  lines.push(
    'Symbol'.padEnd(12) +
    'Events'.padStart(7) +
    'Age(ms)'.padStart(10) +
    'Closed'.padStart(8) +
    'OpenTime'.padStart(22) +
    'CloseTime'.padStart(22) +
    '  Status'
  );
  lines.push('-'.repeat(70));

  for (const sym of SYMBOLS) {
    const state = states.get(sym)!;
    const status = analyzeFreshness(state, now);
    const ageStr = state.lastAgeMs !== null ? String(state.lastAgeMs) : 'N/A';
    const openStr = state.lastOpenTime ? new Date(state.lastOpenTime).toISOString() : 'N/A';
    const closeStr = state.lastCloseTime ? new Date(state.lastCloseTime).toISOString() : 'N/A';
    const marker = status === 'OK' ? 'OK' : 'STALE';
    lines.push(
      state.symbol.padEnd(12) +
      String(state.klineEventCount).padStart(7) +
      ageStr.padStart(10) +
      (state.isClosed ? 'YES' : 'NO').padStart(8) +
      openStr.padStart(22) +
      closeStr.padStart(22) +
      `  ${marker}: ${status}`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  console.log('Starting kline freshness diagnostic...');
  console.log(`Monitoring ${SYMBOLS.length} symbols for ${MONITOR_DURATION_MS / 1000}s`);
  console.log(`Freshness threshold: ${FRESHNESS_MS}ms`);

  for (const sym of SYMBOLS) {
    states.set(sym, initState(sym));
  }

  // Connect to Binance combined stream
  const streams = SYMBOLS.map(s => `${s}@kline_${INTERVAL}`).join('/');
  const url = `wss://fstream.binance.com/stream?streams=${streams}`;

  const ws = new WebSocket(url);
  let connectedAtMs = 0;

  ws.on('open', () => {
    connectedAtMs = Date.now();
    console.log(`Connected to Binance WebSocket at ${new Date(connectedAtMs).toISOString()}`);
  });

  ws.on('message', (data: Buffer) => {
    const now = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      if (msg.data?.e === 'kline') {
        const k = msg.data.k;
        const sym = k.s.toLowerCase();
        const state = states.get(sym);
        if (!state) return;

        state.klineEventCount += 1;
        state.lastKlineEventAtMs = msg.data.E; // Binance event time
        state.lastKlineReceivedAtMs = now;      // Local received time
        state.lastOpenTime = k.t;               // Candle open time
        state.isClosed = k.x;                   // Is candle closed?
        if (k.x) {
          state.lastCloseTime = k.t + 5 * 60 * 1000; // 5m close = openTime + 5min
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.error(`WebSocket closed: code=${code} reason=${reason.toString()}`);
  });

  // Periodic report
  const reportTimer = setInterval(() => {
    console.log(formatReport(Date.now()));
  }, REPORT_INTERVAL_MS);

  // Final report and exit
  setTimeout(() => {
    console.log('\n\nFINAL REPORT:');
    console.log(formatReport(Date.now()));

    // Summary
    console.log('\nSUMMARY:');
    for (const sym of SYMBOLS) {
      const state = states.get(sym)!;
      const status = analyzeFreshness(state, Date.now());
      if (status !== 'OK') {
        console.log(`  ${state.symbol}: ${status}`);
      }
    }

    clearInterval(reportTimer);
    ws.close();
    process.exit(0);
  }, MONITOR_DURATION_MS);
}

main();
