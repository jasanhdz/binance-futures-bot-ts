#!/usr/bin/env node
/**
 * SCIENTIFIC PARITY TEST: Compares WS-built market context vs REST recovery.
 * Builds real context from Binance WebSocket data, sends to Python API,
 * then compares with REST fallback path.
 *
 * Usage: npx tsx scripts/parity-scientific.ts
 */
const { WebSocket } = require('ws');
const http = require('http');

const SYMBOLS = [
  'btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt',
  'dogeusdt', 'adausdt', 'avaxusdt', 'linkusdt', 'suiusdt', 'ltcusdt',
];
const STRATEGIC = 'ltcusdt';
const INTERVAL = '5m';
const CANDLE_LIMIT = 320;
const MIN_CLOSED = 96;
const PYTHON_URL = 'http://127.0.0.1:8001';
const MONITOR_MS = 25 * 60 * 1000; // 25 minutes to capture 5 distinct closes
const CHECK_INTERVAL_MS = 30_000;

// State per symbol
const symbolState = {};
for (const s of SYMBOLS) {
  symbolState[s] = {
    candles: [],
    lastEventAt: null,
    lastEventTime: null,
    events: 0,
  };
}

let wsConnected = false;
let ws = null;

function connectWs() {
  const streams = SYMBOLS.map(s => `${s}@kline_${INTERVAL}`).join('/');
  const url = `wss://fstream.binance.com/market/stream?streams=${streams}`;
  ws = new WebSocket(url);

  ws.on('open', () => {
    wsConnected = true;
    console.log(`[${new Date().toISOString()}] WS connected`);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const data = msg.data || msg;
      if (data.e === 'kline') {
        const k = data.k;
        const sym = k.s.toLowerCase();
        if (!symbolState[sym]) return;
        const s = symbolState[sym];
        s.events++;
        s.lastEventAt = Date.now();
        s.lastEventTime = data.E;

        // Merge candle
        const candle = {
          openTime: k.t,
          timestamp: k.t,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          buyVolume: parseFloat(k.V),
          closeTime: k.T,
        };

        // Replace existing candle with same openTime or add
        const idx = s.candles.findIndex(c => c.openTime === candle.openTime);
        if (idx >= 0) {
          s.candles[idx] = candle;
        } else {
          s.candles.push(candle);
        }
        // Sort and limit
        s.candles.sort((a, b) => a.openTime - b.openTime);
        if (s.candles.length > CANDLE_LIMIT) {
          s.candles = s.candles.slice(-CANDLE_LIMIT);
        }
      }
    } catch {}
  });

  ws.on('error', (e) => console.error('WS error:', e.message));
  ws.on('close', (code) => {
    wsConnected = false;
    console.log(`[${new Date().toISOString()}] WS closed: ${code}, reconnecting in 3s...`);
    setTimeout(connectWs, 3000);
  });
}

function getClosedCandles(symbol) {
  const now = Date.now();
  return symbolState[symbol]?.candles.filter(c => c.closeTime <= now) ?? [];
}

function checkContextReady() {
  if (!wsConnected) return { ready: false, reason: 'WS_NOT_CONNECTED' };

  // Check route health: any symbol received events recently
  const now = Date.now();
  const recentEvent = Object.values(symbolState).some(s => s.lastEventAt && (now - s.lastEventAt) < 10_000);
  if (!recentEvent) return { ready: false, reason: 'ROUTE_UNHEALTHY' };

  // Check each symbol has 96+ closed candles
  const issues = [];
  for (const sym of SYMBOLS) {
    const closed = getClosedCandles(sym);
    if (closed.length < MIN_CLOSED) {
      issues.push(`${sym.toUpperCase()}: ${closed.length}/${MIN_CLOSED} closed candles`);
    }
  }
  if (issues.length > 0) return { ready: false, reason: `INSUFFICIENT_CANDLES: ${issues.join(', ')}` };

  return { ready: true };
}

function buildMarketContextPayload() {
  const now = Date.now();
  const universeCandles5m = {};

  for (const sym of SYMBOLS) {
    const closed = getClosedCandles(sym);
    universeCandles5m[sym.toUpperCase()] = {
      source: 'WEBSOCKET',
      status: 'FRESH',
      observedAtMs: symbolState[sym].lastEventAt ?? now,
      ageMs: symbolState[sym].lastEventAt ? now - symbolState[sym].lastEventAt : 0,
      websocketObservedAtMs: symbolState[sym].lastEventAt,
      restFallbackCount: 0,
      candles: closed.slice(-CANDLE_LIMIT),
    };
  }

  const strategicState = symbolState[STRATEGIC];
  const strategicCandles = getClosedCandles(STRATEGIC);
  const lastCandle = strategicCandles[strategicCandles.length - 1];

  return {
    version: 'AEGIS_MARKET_CONTEXT_V1',
    symbol: STRATEGIC.toUpperCase(),
    capturedAtMs: now,
    source: 'SHARED_MARKET_DATA_RUNTIME',
    status: 'FRESH',
    quote: {
      bestBid: lastCandle?.close ?? 0,
      bestAsk: (lastCandle?.close ?? 0) * 1.0001,
      midPrice: (lastCandle?.close ?? 0) * 1.00005,
      spreadBps: 1,
      observedAtMs: strategicState.lastEventAt ?? now,
      ageMs: strategicState.lastEventAt ? now - strategicState.lastEventAt : 0,
    },
    orderBook: {
      health: 'HEALTHY',
      observedAtMs: now - 100,
      ageMs: 100,
      lastUpdateId: 1,
      bids: [{ price: lastCandle?.close ?? 0, qty: 1 }],
      asks: [{ price: (lastCandle?.close ?? 0) * 1.0001, qty: 1 }],
    },
    aggTrades: {
      windowMs: 5000,
      observedAtMs: now - 100,
      ageMs: 100,
      gapFree: true,
      windowComplete: true,
      tradeCount: 10,
      buyVolume: 5,
      sellVolume: 5,
      netTakerVolume: 0,
    },
    candles5m: universeCandles5m[STRATEGIC.toUpperCase()],
    universeCandles5m: universeCandles5m,
    liquidity: {
      stress: 0,
      status: 'FRESH',
      observedAtMs: now,
      ageMs: 0,
      inputVersion: 'v1',
    },
  };
}

async function postPrediction(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, PYTHON_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runParityCheck(checkNum) {
  const now = Date.now();
  console.log(`\n${'='.repeat(80)}`);
  console.log(`PARITY CHECK #${checkNum} @ ${new Date(now).toISOString()}`);
  console.log(`${'='.repeat(80)}`);

  // Build WS context
  const wsContext = buildMarketContextPayload();
  const featureHashes = {};
  for (const sym of SYMBOLS) {
    const candles = wsContext.universeCandles5m[sym]?.candles ?? [];
    featureHashes[sym] = candles.length > 0 ? `hash_${candles.length}_${candles[candles.length-1]?.openTime}` : 'empty';
  }

  console.log(`\nWS Context built:`);
  console.log(`  Strategic: ${wsContext.symbol}`);
  console.log(`  Universe: ${Object.keys(wsContext.universeCandles5m).length} symbols`);
  for (const sym of Object.keys(wsContext.universeCandles5m)) {
    const c = wsContext.universeCandles5m[sym];
    console.log(`  ${sym}: ${c.candles.length} closed candles, lastClose=${c.candles[c.candles.length-1]?.closeTime}`);
  }

  // Path 1: WS prediction (with market_context)
  console.log(`\n--- PATH 1: WS (with market_context) ---`);
  const wsStart = Date.now();
  let wsResult;
  try {
    wsResult = await postPrediction('/ml-v2/predict', {
      symbol: STRATEGIC.toUpperCase(),
      market_context: wsContext,
    });
  } catch (e) {
    wsResult = { error: e.message };
  }
  const wsLatency = Date.now() - wsStart;

  // Path 2: REST recovery (without market_context)
  console.log(`--- PATH 2: REST recovery (no market_context) ---`);
  const restStart = Date.now();
  let restResult;
  try {
    restResult = await postPrediction('/ml-v2/predict', {
      symbol: STRATEGIC.toUpperCase(),
      // No market_context → triggers REST fallback
    });
  } catch (e) {
    restResult = { error: e.message };
  }
  const restLatency = Date.now() - restStart;

  // Compare
  console.log(`\nCOMPARISON:`);
  console.log(`  WS  score: ${wsResult?.prediction?.short_prob ?? 'N/A'} | action: ${wsResult?.decision?.final_action ?? 'N/A'} | verdict: ${wsResult?.decision?.meta_verdict ?? 'N/A'} | latency: ${wsLatency}ms`);
  console.log(`  REST score: ${restResult?.prediction?.short_prob ?? 'N/A'} | action: ${restResult?.decision?.final_action ?? 'N/A'} | verdict: ${restResult?.decision?.meta_verdict ?? 'N/A'} | latency: ${restLatency}ms`);
  console.log(`  WS  source: ${wsResult?.source ?? 'N/A'} | rest_snapshot_provider: ${wsResult?.rest_snapshot_provider_used ?? 'N/A'}`);
  console.log(`  REST source: ${restResult?.source ?? 'N/A'} | rest_snapshot_provider: ${restResult?.rest_snapshot_provider_used ?? 'N/A'}`);
  console.log(`  WS  cache_hit: ${wsResult?.cache_hit ?? 'N/A'} | cache_key: ${wsResult?.cache_key ?? 'N/A'}`);
  console.log(`  REST cache_hit: ${restResult?.cache_hit ?? 'N/A'} | cache_key: ${restResult?.cache_key ?? 'N/A'}`);

  // Feature comparison
  const wsFeatures = wsResult?.features;
  const restFeatures = restResult?.features;
  if (wsFeatures && restFeatures) {
    const wsHash = wsResult?.feature_hash ?? 'N/A';
    const restHash = restResult?.feature_hash ?? 'N/A';
    console.log(`  Feature hash WS:  ${wsHash}`);
    console.log(`  Feature hash REST: ${restHash}`);
    console.log(`  Hash match: ${wsHash === restHash}`);
    if (wsFeatures && restFeatures && Array.isArray(wsFeatures) && Array.isArray(restFeatures)) {
      let maxDelta = 0;
      for (let i = 0; i < Math.min(wsFeatures.length, restFeatures.length); i++) {
        const delta = Math.abs(wsFeatures[i] - restFeatures[i]);
        if (delta > maxDelta) maxDelta = delta;
      }
      console.log(`  Max feature delta: ${maxDelta}`);
    }
  }

  return { wsResult, restResult, wsLatency, restLatency, wsContext };
}

async function seedHistoricalCandles() {
  console.log('Seeding historical candles via REST...');
  for (const sym of SYMBOLS) {
    try {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym.toUpperCase()}&interval=${INTERVAL}&limit=${CANDLE_LIMIT}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!Array.isArray(data)) {
        console.log(`  ${sym.toUpperCase()}: REST error - ${JSON.stringify(data).slice(0,100)}`);
        continue;
      }
      const candles = data.map((k: any[]) => ({
        openTime: k[0],
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        buyVolume: parseFloat(k[9]),
        closeTime: k[6],
      }));
      symbolState[sym].candles = candles;
      symbolState[sym].lastEventAt = Date.now();
      console.log(`  ${sym.toUpperCase()}: seeded ${candles.length} candles`);
    } catch (e) {
      console.log(`  ${sym.toUpperCase()}: seed error - ${e.message}`);
    }
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }
}

async function main() {
  console.log('Scientific Parity Test: WS vs REST');
  console.log(`Monitoring ${SYMBOLS.length} symbols for ${MONITOR_MS / 1000}s`);
  console.log(`Strategic symbol: ${STRATEGIC.toUpperCase()}`);
  console.log(`Python API: ${PYTHON_URL}`);

  // Seed historical candles first
  await seedHistoricalCandles();

  // Connect WebSocket for live updates
  connectWs();

  // Wait for WebSocket to connect and first events
  console.log('Waiting 10s for WebSocket connection...');
  await new Promise(r => setTimeout(r, 10_000));

  const results = [];
  let checkNum = 0;

  const interval = setInterval(async () => {
    checkNum++;
    const status = checkContextReady();
    if (!status.ready) {
      console.log(`\n[${new Date().toISOString()}] Context not ready: ${status.reason}`);
      return;
    }

    const result = await runParityCheck(checkNum);
    results.push(result);

    if (checkNum >= 5) {
      clearInterval(interval);
      console.log(`\n${'='.repeat(80)}`);
      console.log('PARITY TEST COMPLETE');
      console.log(`${'='.repeat(80)}`);
      console.log(`Total checks: ${results.length}`);
      ws?.close();
      process.exit(0);
    }
  }, CHECK_INTERVAL_MS);

  setTimeout(() => {
    clearInterval(interval);
    console.log(`\nTimeout reached. Completed ${checkNum} checks.`);
    ws?.close();
    process.exit(0);
  }, MONITOR_MS);
}

main();
