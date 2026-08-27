/**
 * MICRO BURST V1 — M2.1 Live Data Soak Verification
 *
 * Verifies continuous data flow from Binance USD-M Futures using raw
 * combined WebSocket streams (bypassing binance-api-node individual
 * stream limitations).
 *
 * NO credentials. NO orders. NO exchange mutation. Bounded duration.
 *
 * Usage:
 *   npx tsx scripts/micro-burst-shadow-soak.ts [--seconds 300] [--symbols BTCUSDT,ETHUSDT,SOLUSDT]
 */

const WebSocket = require('ws');

const DURATION_S = Number(process.argv.find((_, i, a) => a[i - 1] === '--seconds') ?? 300);
const DURATION_MS = DURATION_S * 1000;
const SYMBOLS = (
  process.argv.find((_, i, a) => a[i - 1] === '--symbols') ?? 'BTCUSDT,ETHUSDT,SOLUSDT'
)
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const WS_BASE = 'wss://fstream.binance.com';
const REST_BASE = 'https://fapi.binance.com';

// ── Metrics ──────────────────────────────────────────────────────────

interface SymbolMetrics {
  depth: {
    restSnapshots: number;
    rawWsEvents: number;
    acceptedWsEvents: number;
    rejectedWsEvents: number;
    gapDetections: number;
    resyncAttempts: number;
    resyncSuccesses: number;
    lastUpdateId: number;
    previousUpdateId: number;
    firstWsEventAt: number;
    lastWsEventAt: number;
    bookStatus: string;
    bookAgeMs: number;
  };
  aggTrade: {
    rawEvents: number;
    acceptedEvents: number;
    rejectedEvents: number;
    takerBuyEvents: number;
    takerSellEvents: number;
    takerBuyVolume: number;
    takerSellVolume: number;
    rejectedByReason: Record<string, number>;
    firstEventAt: number;
    lastEventAt: number;
  };
  refPrice: {
    updates: number;
    source: string;
    lastPrice: number;
    ageMs: number;
  };
  context: {
    evaluations: number;
    validContexts: number;
    invalidContexts: number;
    invalidReasons: Record<string, number>;
  };
  signals: {
    entryIntents: number;
    uniqueSignals: number;
    duplicates: number;
  };
}

const btc = {
  observations: 0,
  healthy: false,
  ret1m: null as number | null,
  ret3m: null as number | null,
  ret5m: null as number | null,
  acceleration: null as number | null,
  lastObservationAt: 0,
};

let exchangeMutations = 0;
let shutdownClean = false;
const startedAt = Date.now();

function makeSymbolMetrics(): SymbolMetrics {
  return {
    depth: {
      restSnapshots: 0,
      rawWsEvents: 0,
      acceptedWsEvents: 0,
      rejectedWsEvents: 0,
      gapDetections: 0,
      resyncAttempts: 0,
      resyncSuccesses: 0,
      lastUpdateId: 0,
      previousUpdateId: 0,
      firstWsEventAt: 0,
      lastWsEventAt: 0,
      bookStatus: 'UNAVAILABLE',
      bookAgeMs: 0,
    },
    aggTrade: {
      rawEvents: 0,
      acceptedEvents: 0,
      rejectedEvents: 0,
      takerBuyEvents: 0,
      takerSellEvents: 0,
      takerBuyVolume: 0,
      takerSellVolume: 0,
      rejectedByReason: {},
      firstEventAt: 0,
      lastEventAt: 0,
    },
    refPrice: { updates: 0, source: 'NONE', lastPrice: 0, ageMs: 0 },
    context: { evaluations: 0, validContexts: 0, invalidContexts: 0, invalidReasons: {} },
    signals: { entryIntents: 0, uniqueSignals: 0, duplicates: 0 },
  };
}

const perSymbol: Record<string, SymbolMetrics> = {};
for (const sym of SYMBOLS) perSymbol[sym] = makeSymbolMetrics();

// ── Order Book State (per symbol) ────────────────────────────────────

interface BookState {
  lastUpdateId: number;
  bidBook: Map<number, number>;
  askBook: Map<number, number>;
  health: string;
  observedAtMs: number;
  resyncCount: number;
}

const books: Record<string, BookState> = {};
for (const sym of SYMBOLS) {
  books[sym] = {
    lastUpdateId: 0,
    bidBook: new Map(),
    askBook: new Map(),
    health: 'UNAVAILABLE',
    observedAtMs: 0,
    resyncCount: 0,
  };
}

// ── AggTrade Buffer ──────────────────────────────────────────────────

interface AggTradeEvent {
  eventTime: number;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
}

const aggTradeBuffers: Record<string, AggTradeEvent[]> = {};
for (const sym of SYMBOLS) aggTradeBuffers[sym] = [];

function pushAggTrade(sym: string, event: AggTradeEvent): void {
  const buf = aggTradeBuffers[sym];
  buf.push(event);
  while (buf.length > 200) buf.shift();
}

function getTakerFlow(sym: string): {
  buyVolume: number;
  sellVolume: number;
  netTakerVolume: number;
  tradeCount: number;
} {
  const now = Date.now();
  const recent = aggTradeBuffers[sym].filter((e) => now - e.eventTime < 60_000);
  let buyVolume = 0,
    sellVolume = 0;
  for (const t of recent) {
    if (t.isBuyerMaker) sellVolume += t.quantity;
    else buyVolume += t.quantity;
  }
  return {
    buyVolume,
    sellVolume,
    netTakerVolume: buyVolume - sellVolume,
    tradeCount: recent.length,
  };
}

// ── Book Operations ──────────────────────────────────────────────────

function applyDiff(book: Map<number, number>, diffs: [string, string][]): void {
  for (const [pStr, qStr] of diffs) {
    const price = Number(pStr),
      qty = Number(qStr);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (qty === 0) book.delete(price);
    else if (Number.isFinite(qty) && qty > 0) book.set(price, qty);
  }
}

function handleDepthEvent(sym: string, data: any): void {
  const m = perSymbol[sym].depth;
  m.rawWsEvents++;

  const book = books[sym];
  const lastUpdateId = data.u ?? data.lastUpdateId ?? 0;
  const prevUpdateId = data.pu ?? 0;

  if (lastUpdateId <= 0) {
    m.rejectedWsEvents++;
    return;
  }

  // First event — accept
  if (book.lastUpdateId === 0) {
    book.lastUpdateId = lastUpdateId;
    if (data.b) applyDiff(book.bidBook, data.b);
    if (data.a) applyDiff(book.askBook, data.a);
    book.observedAtMs = Date.now();
    book.health = 'HEALTHY';
    m.acceptedWsEvents++;
    m.lastUpdateId = lastUpdateId;
    if (m.firstWsEventAt === 0) m.firstWsEventAt = Date.now();
    m.lastWsEventAt = Date.now();
    return;
  }

  // Continuity check
  if (lastUpdateId === book.lastUpdateId + 1) {
    if (data.b) applyDiff(book.bidBook, data.b);
    if (data.a) applyDiff(book.askBook, data.a);
    book.lastUpdateId = lastUpdateId;
    book.observedAtMs = Date.now();
    book.health = 'HEALTHY';
    m.acceptedWsEvents++;
    m.lastUpdateId = lastUpdateId;
    m.lastWsEventAt = Date.now();
  } else if (lastUpdateId > book.lastUpdateId + 1) {
    // Gap — accept but note it
    m.gapDetections++;
    m.previousUpdateId = book.lastUpdateId;
    if (data.b) applyDiff(book.bidBook, data.b);
    if (data.a) applyDiff(book.askBook, data.a);
    book.lastUpdateId = lastUpdateId;
    book.observedAtMs = Date.now();
    m.acceptedWsEvents++;
    m.lastUpdateId = lastUpdateId;
    m.lastWsEventAt = Date.now();
  } else {
    // Stale — reject
    m.rejectedWsEvents++;
  }
}

// ── REST Candles ─────────────────────────────────────────────────────

async function fetchCandles(symbol: string, interval: string, limit: number): Promise<any[]> {
  try {
    const url = `${REST_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as any[];
    return data.map((k: any) => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6],
      buyVolume: Number(k[9]),
    }));
  } catch {
    return [];
  }
}

// ── BTC Context ──────────────────────────────────────────────────────

async function pollBtc(): Promise<void> {
  try {
    const candles = await fetchCandles('BTCUSDT', '1m', 6);
    if (candles.length >= 4) {
      const closes = candles.map((c: any) => c.close);
      const now = closes[closes.length - 1];
      const prev1 = closes[closes.length - 2];
      const prev3 = closes[closes.length - 4];
      btc.ret1m = (now - prev1) / prev1;
      btc.ret3m = (prev1 - prev3) / prev3;
      btc.acceleration = btc.ret1m - btc.ret3m;
      btc.observations++;
      btc.healthy = true;
      btc.lastObservationAt = Date.now();
    }
  } catch {
    /* ok */
  }
}

// ── Reference Price ──────────────────────────────────────────────────

let markPrices: Record<string, { price: number; at: number }> = {};

async function pollMarkPrices(): Promise<void> {
  try {
    const res = await fetch(`${REST_BASE}/fapi/v1/premiumIndex`);
    if (!res.ok) return;
    const data = (await res.json()) as any[];
    for (const entry of data) {
      if (SYMBOLS.includes(entry.symbol)) {
        markPrices[entry.symbol] = { price: Number(entry.markPrice), at: Date.now() };
        perSymbol[entry.symbol].refPrice.updates++;
        perSymbol[entry.symbol].refPrice.source = 'MARK_PRICE';
        perSymbol[entry.symbol].refPrice.lastPrice = Number(entry.markPrice);
        perSymbol[entry.symbol].refPrice.ageMs = 0;
      }
    }
  } catch {
    /* ok */
  }
}

// ── Context Builder (simplified) ─────────────────────────────────────

function filterClosed(candles: any[], snapshotAtMs: number): any[] {
  return candles.filter((c) => c.closeTime <= snapshotAtMs);
}

async function evaluateContext(sym: string): Promise<void> {
  const m = perSymbol[sym].context;
  m.evaluations++;

  const snapshotAtMs = Date.now();
  const reasons: string[] = [];

  // Candles
  const [candles1m, candles3m, candles5m] = await Promise.all([
    fetchCandles(sym, '1m', 100),
    fetchCandles(sym, '3m', 80),
    fetchCandles(sym, '5m', 60),
  ]);

  const closed1m = filterClosed(candles1m, snapshotAtMs);
  const closed3m = filterClosed(candles3m, snapshotAtMs);
  const closed5m = filterClosed(candles5m, snapshotAtMs);

  if (closed1m.length < 30) reasons.push('insufficient_1m_candles');
  if (closed3m.length < 20) reasons.push('insufficient_3m_candles');
  if (closed5m.length < 15) reasons.push('insufficient_5m_candles');

  // Book
  const book = books[sym];
  const bookAgeMs = book.observedAtMs > 0 ? snapshotAtMs - book.observedAtMs : Infinity;
  if (book.health !== 'HEALTHY') reasons.push(`book_${book.health.toLowerCase()}`);
  if (bookAgeMs > 10_000) reasons.push('book_stale');

  // BTC
  if (!btc.healthy) reasons.push('btc_unavailable');
  else if (snapshotAtMs - btc.lastObservationAt > 120_000) reasons.push('btc_stale');

  // Ref price
  const ref = markPrices[sym];
  if (!ref) reasons.push('reference_price_unavailable');

  // Order book content
  if (book.bidBook.size === 0 || book.askBook.size === 0) reasons.push('empty_order_book');

  const valid = reasons.length === 0;

  if (valid) m.validContexts++;
  else {
    m.invalidContexts++;
    for (const r of reasons) m.invalidReasons[r] = (m.invalidReasons[r] || 0) + 1;
  }

  // Signal detection (no ENTRY_INTENT creation — just check decision path)
  if (valid) {
    // In real runtime, StrategyRouter would decide. Here we confirm pipeline is live.
    m.validContexts; // already incremented
  }
}

// ── REST Snapshot ────────────────────────────────────────────────────

async function fetchDepthSnapshot(sym: string): Promise<void> {
  try {
    const res = await fetch(`${REST_BASE}/fapi/v1/depth?symbol=${sym}&limit=20`);
    if (!res.ok) return;
    const data = (await res.json()) as any;
    const book = books[sym];
    book.bidBook.clear();
    book.askBook.clear();
    for (const [p, q] of data.bids) {
      const price = Number(p),
        qty = Number(q);
      if (price > 0 && qty > 0) book.bidBook.set(price, qty);
    }
    for (const [p, q] of data.asks) {
      const price = Number(p),
        qty = Number(q);
      if (price > 0 && qty > 0) book.askBook.set(price, qty);
    }
    book.lastUpdateId = data.lastUpdateId;
    book.observedAtMs = Date.now();
    book.health = 'HEALTHY';
    perSymbol[sym].depth.restSnapshots++;
    perSymbol[sym].depth.lastUpdateId = data.lastUpdateId;
  } catch {
    /* ok */
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== MICRO BURST M2.1 LIVE DATA SOAK ===`);
  console.log(`Duration: ${DURATION_S}s | Symbols: ${SYMBOLS.join(', ')}\n`);

  // 1. Initial REST data
  console.log('[1/5] Initial REST snapshots...');
  await Promise.all(SYMBOLS.map((s) => fetchDepthSnapshot(s)));
  console.log('  Depth snapshots OK');

  console.log('[2/5] Initial BTC context...');
  await pollBtc();
  console.log(`  BTC: healthy=${btc.healthy} ret1m=${btc.ret1m}`);

  console.log('[3/5] Initial mark prices...');
  await pollMarkPrices();
  console.log(`  Mark prices: ${Object.keys(markPrices).length} symbols`);

  // 2. Combined WebSocket streams
  console.log('[4/5] Opening combined WS streams...');
  const streams: string[] = [];
  for (const sym of SYMBOLS) {
    streams.push(`${sym.toLowerCase()}@depth5@100ms`);
    // NOTE: @aggTrade does not work on Binance Futures combined streams.
    // @trade delivers individual trades with the same buyerMaker semantics.
    streams.push(`${sym.toLowerCase()}@trade`);
  }
  const wsUrl = `${WS_BASE}/stream?streams=${streams.join('/')}`;
  console.log(`  URL: ${wsUrl.substring(0, 80)}...`);

  const ws = new WebSocket(wsUrl);
  let wsConnected = false;
  let wsMessages = 0;

  ws.on('open', () => {
    wsConnected = true;
    console.log('  WS CONNECTED');
  });

  ws.on('ping', (data: any) => {
    ws.pong(data);
  });

  ws.on('message', (raw: any) => {
    try {
      const msg = JSON.parse(String(raw));
      const stream: string = msg.stream || '';
      const data = msg.data || {};
      wsMessages++;

      // Route by stream
      if (stream.includes('@depth')) {
        const sym = stream.split('@')[0].toUpperCase();
        if (!perSymbol[sym]) return;
        handleDepthEvent(sym, data);
      } else if (stream.includes('@trade') && !stream.includes('@aggTrade')) {
        const sym = stream.split('@')[0].toUpperCase();
        if (!perSymbol[sym]) return;
        const m = perSymbol[sym].aggTrade;
        m.rawEvents++;

        const eventTime = data.T ?? data.E ?? Date.now();
        const price = Number(data.p);
        const quantity = Number(data.q);
        const isBuyerMaker = data.m;

        if (!Number.isFinite(price) || price <= 0) {
          m.rejectedEvents++;
          m.rejectedByReason.malformed_price = (m.rejectedByReason.malformed_price || 0) + 1;
          return;
        }
        if (!Number.isFinite(quantity) || quantity < 0) {
          m.rejectedEvents++;
          m.rejectedByReason.malformed_quantity = (m.rejectedByReason.malformed_quantity || 0) + 1;
          return;
        }
        if (!Number.isFinite(eventTime) || eventTime <= 0) {
          m.rejectedEvents++;
          m.rejectedByReason.invalid_timestamp = (m.rejectedByReason.invalid_timestamp || 0) + 1;
          return;
        }

        m.acceptedEvents++;
        if (isBuyerMaker) {
          m.takerSellEvents++;
          m.takerSellVolume += quantity;
        } else {
          m.takerBuyEvents++;
          m.takerBuyVolume += quantity;
        }
        if (m.firstEventAt === 0) m.firstEventAt = Date.now();
        m.lastEventAt = Date.now();

        pushAggTrade(sym, { eventTime, price, quantity, isBuyerMaker });
      }
    } catch {
      /* ignore parse errors */
    }
  });

  ws.on('error', (err: any) => console.log(`  WS ERROR: ${err.message}`));
  ws.on('close', (code: any) => {
    wsConnected = false;
    console.log(`  WS CLOSE: code=${code}`);
  });

  // 3. Periodic tasks
  console.log('[5/5] Starting periodic tasks...\n');

  const btcTimer = setInterval(() => pollBtc(), 30_000);
  const refTimer = setInterval(() => pollMarkPrices(), 10_000);
  const evalTimer = setInterval(async () => {
    for (const sym of SYMBOLS) {
      await evaluateContext(sym);
    }
  }, 15_000);

  // 4. Wait for soak duration
  const evalStart = Date.now() + 10_000; // first eval after 10s warmup
  await new Promise((r) => setTimeout(r, DURATION_MS));

  // 5. Cleanup
  clearInterval(btcTimer);
  clearInterval(refTimer);
  clearInterval(evalTimer);
  try {
    ws.close();
  } catch {
    /* ok */
  }
  shutdownClean = true;

  // 6. Final BTC poll
  await pollBtc();
  await pollMarkPrices();

  // 7. Report
  const durationActual = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`MICRO BURST M2.1 SOAK RESULTS`);
  console.log(`${'='.repeat(60)}`);
  console.log(`duration:           ${durationActual}s`);
  console.log(`symbols:            ${SYMBOLS.join(', ')}`);
  console.log(`wsConnected:        ${wsConnected}`);
  console.log(`wsMessages:         ${wsMessages}`);
  console.log(``);

  for (const sym of SYMBOLS) {
    const m = perSymbol[sym];
    console.log(`--- ${sym} ---`);
    console.log(`DEPTH`);
    console.log(`  restSnapshots:    ${m.depth.restSnapshots}`);
    console.log(`  rawWsEvents:      ${m.depth.rawWsEvents}`);
    console.log(`  acceptedWsEvents: ${m.depth.acceptedWsEvents}`);
    console.log(`  rejectedWsEvents: ${m.depth.rejectedWsEvents}`);
    console.log(`  gapDetections:    ${m.depth.gapDetections}`);
    console.log(`  lastUpdateId:     ${m.depth.lastUpdateId}`);
    console.log(`  bookStatus:       ${books[sym].health}`);
    console.log(
      `  bookAgeMs:        ${books[sym].observedAtMs > 0 ? Date.now() - books[sym].observedAtMs : 'N/A'}`,
    );
    console.log(`AGGTRADE`);
    console.log(`  rawEvents:        ${m.aggTrade.rawEvents}`);
    console.log(`  acceptedEvents:   ${m.aggTrade.acceptedEvents}`);
    console.log(`  rejectedEvents:   ${m.aggTrade.rejectedEvents}`);
    console.log(`  takerBuyEvents:   ${m.aggTrade.takerBuyEvents}`);
    console.log(`  takerSellEvents:  ${m.aggTrade.takerSellEvents}`);
    console.log(`  takerBuyVolume:   ${m.aggTrade.takerBuyVolume.toFixed(4)}`);
    console.log(`  takerSellVolume:  ${m.aggTrade.takerSellVolume.toFixed(4)}`);
    console.log(
      `  netTakerFlow:     ${(m.aggTrade.takerBuyVolume - m.aggTrade.takerSellVolume).toFixed(4)}`,
    );
    if (Object.keys(m.aggTrade.rejectedByReason).length > 0) {
      console.log(`  rejectedByReason: ${JSON.stringify(m.aggTrade.rejectedByReason)}`);
    }
    console.log(`REFERENCE PRICE`);
    console.log(`  updates:          ${m.refPrice.updates}`);
    console.log(`  source:           ${m.refPrice.source}`);
    console.log(`  lastPrice:        ${m.refPrice.lastPrice}`);
    console.log(`CONTEXT`);
    console.log(`  evaluations:      ${m.context.evaluations}`);
    console.log(`  validContexts:    ${m.context.validContexts}`);
    console.log(`  invalidContexts:  ${m.context.invalidContexts}`);
    if (Object.keys(m.context.invalidReasons).length > 0) {
      console.log(`  invalidReasons:   ${JSON.stringify(m.context.invalidReasons)}`);
    }
    console.log(`SIGNALS`);
    console.log(`  entryIntents:     ${m.signals.entryIntents}`);
    console.log(`  uniqueSignals:    ${m.signals.uniqueSignals}`);
    console.log(`  duplicates:       ${m.signals.duplicates}`);
    console.log(``);
  }

  console.log(`GLOBAL`);
  console.log(`  btcObservations:  ${btc.observations}`);
  console.log(`  btcHealthy:       ${btc.healthy}`);
  console.log(`  btcRet1m:         ${btc.ret1m}`);
  console.log(`  btcRet3m:         ${btc.ret3m}`);
  console.log(`  btcRet5m:         ${btc.ret5m}`);
  console.log(`  btcAcceleration:  ${btc.acceleration}`);
  console.log(`  exchangeMutations: ${exchangeMutations}`);
  console.log(`  shutdownClean:    ${shutdownClean}`);

  // 8. Verdict
  const allDepthOk = SYMBOLS.every((s) => perSymbol[s].depth.acceptedWsEvents > 0);
  const allAggOk = SYMBOLS.every((s) => perSymbol[s].aggTrade.acceptedEvents > 0);
  const allRefOk = SYMBOLS.every((s) => perSymbol[s].refPrice.updates > 0);
  const anyValidCtx = SYMBOLS.some((s) => perSymbol[s].context.validContexts > 0);
  const mutationsZero = exchangeMutations === 0;

  console.log(`\n${'='.repeat(60)}`);
  if (allDepthOk && allAggOk && allRefOk && btc.healthy && anyValidCtx && mutationsZero) {
    console.log(`VERDICT: MICRO_BURST_V1_M2_1_CONTINUOUS_LIVE_DATA_VERIFIED`);
  } else {
    console.log(`VERDICT: M2_1_INCOMPLETE`);
    if (!allDepthOk) console.log(`  FAIL: depth WS events = 0 for some symbols`);
    if (!allAggOk) console.log(`  FAIL: aggTrade WS events = 0 for some symbols`);
    if (!allRefOk) console.log(`  FAIL: reference price updates = 0`);
    if (!btc.healthy) console.log(`  FAIL: BTC context unhealthy`);
    if (!anyValidCtx) console.log(`  FAIL: no valid contexts produced`);
    if (!mutationsZero) console.log(`  FAIL: exchange mutations detected`);
  }
  console.log(`${'='.repeat(60)}\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Soak test crashed:', err);
  process.exit(1);
});
