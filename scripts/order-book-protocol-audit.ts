import fs from 'node:fs';
import WebSocket from 'ws';

type DepthEvent = { e: 'depthUpdate'; E: number; T: number; s: string; U: number; u: number; pu: number; b: [string, string][]; a: [string, string][] };
type BufferedEvent = DepthEvent & { receivedAtMs: number };
type Snapshot = { lastUpdateId: number; E?: number; T?: number; bids: [string, string][]; asks: [string, string][] };
type Bridge = null | { index: number; U: number; u: number; pu: number };
type Mismatch = null | { index: number; expectedPu: number; actualPu: number; U: number; u: number };
type SymbolAudit = {
  symbol: string;
  snapshotLastUpdateId: number;
  snapshotLatencyMs: number;
  totalEvents: number;
  eventsBufferedBeforeSnapshotResponse: number;
  eventRatePerSecond: number;
  officialBridge: Bridge;
  currentPlusOneBridge: Bridge;
  bridgeSelectionDiffers: boolean;
  officialChainPuMismatches: number;
  currentChainPuMismatches: number;
  firstOfficialChainMismatch: Mismatch;
  firstCurrentChainMismatch: Mismatch;
};

const symbols = (process.env.ORDER_BOOK_AUDIT_SYMBOLS ?? 'BTCUSDT,ETHUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const preSnapshotBufferMs = Number(process.env.ORDER_BOOK_AUDIT_PRE_SNAPSHOT_MS ?? 750);
const postSnapshotObserveMs = Number(process.env.ORDER_BOOK_AUDIT_POST_SNAPSHOT_MS ?? 4_000);
const snapshotLimit = Number(process.env.ORDER_BOOK_AUDIT_SNAPSHOT_LIMIT ?? 1_000);
const outputPath = process.env.ORDER_BOOK_AUDIT_OUTPUT ?? 'order-book-protocol-audit.json';
const hardTimeoutMs = Number(process.env.ORDER_BOOK_AUDIT_HARD_TIMEOUT_MS ?? 30_000);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchSnapshot(symbol: string): Promise<{ snapshot: Snapshot; latencyMs: number; completedAtMs: number }> {
  const startedAtMs = Date.now();
  const response = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${snapshotLimit}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${symbol} snapshot HTTP ${response.status}`);
  const snapshot = (await response.json()) as Snapshot;
  if (!Number.isSafeInteger(snapshot.lastUpdateId) || snapshot.lastUpdateId < 0) throw new Error(`invalid ${symbol}.lastUpdateId`);
  const completedAtMs = Date.now();
  return { snapshot, latencyMs: completedAtMs - startedAtMs, completedAtMs };
}

function findOfficialBridge(events: BufferedEvent[], lastUpdateId: number): number {
  return events.findIndex((event) => event.u >= lastUpdateId && event.U <= lastUpdateId && lastUpdateId <= event.u);
}
function findCurrentPlusOneBridge(events: BufferedEvent[], lastUpdateId: number): number {
  const boundary = lastUpdateId + 1;
  return events.findIndex((event) => event.u >= boundary && event.U <= boundary && boundary <= event.u);
}
function bridge(events: BufferedEvent[], index: number): Bridge {
  if (index < 0) return null;
  const e = events[index];
  return { index, U: e.U, u: e.u, pu: e.pu };
}
function inspectChain(events: BufferedEvent[], start: number): { mismatches: number; first: Mismatch } {
  if (start < 0) return { mismatches: 0, first: null };
  let previousU = events[start].u;
  let mismatches = 0;
  let first: Mismatch = null;
  for (let index = start + 1; index < events.length; index++) {
    const event = events[index];
    if (event.u <= previousU) continue;
    if (event.pu !== previousU) {
      mismatches++;
      first ??= { index, expectedPu: previousU, actualPu: event.pu, U: event.U, u: event.u };
    }
    previousU = event.u;
  }
  return { mismatches, first };
}

async function run(): Promise<void> {
  if (symbols.length < 1 || symbols.length > 4) throw new Error('audit supports 1-4 symbols');
  const streams = symbols.map((s) => `${s.toLowerCase()}@depth@100ms`).join('/');
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  const events = new Map<string, BufferedEvent[]>(symbols.map((s) => [s, []]));
  try {
    const openedAtMs = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket open timeout')), 15_000);
      ws.once('open', () => { clearTimeout(timer); resolve(Date.now()); });
      ws.once('error', reject);
    });
    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString()) as { data?: DepthEvent } | DepthEvent;
      const event = 'data' in parsed && parsed.data ? parsed.data : parsed as DepthEvent;
      if (event?.e !== 'depthUpdate' || !event.s || ![event.U, event.u, event.pu, event.E, event.T].every(Number.isSafeInteger)) return;
      events.get(event.s.toUpperCase())?.push({ ...event, receivedAtMs: Date.now() });
    });
    await sleep(preSnapshotBufferMs);
    const snapshots = new Map(await Promise.all(symbols.map(async (symbol) => [symbol, await fetchSnapshot(symbol)] as const)));
    await sleep(postSnapshotObserveMs);
    const finishedAtMs = Date.now();
    const audits: SymbolAudit[] = symbols.map((symbol) => {
      const symbolEvents = events.get(symbol) ?? [];
      const snapshotResult = snapshots.get(symbol)!;
      const officialIndex = findOfficialBridge(symbolEvents, snapshotResult.snapshot.lastUpdateId);
      const currentIndex = findCurrentPlusOneBridge(symbolEvents, snapshotResult.snapshot.lastUpdateId);
      const officialChain = inspectChain(symbolEvents, officialIndex);
      const currentChain = inspectChain(symbolEvents, currentIndex);
      const seconds = Math.max(0.001, (finishedAtMs - openedAtMs) / 1000);
      return {
        symbol,
        snapshotLastUpdateId: snapshotResult.snapshot.lastUpdateId,
        snapshotLatencyMs: snapshotResult.latencyMs,
        totalEvents: symbolEvents.length,
        eventsBufferedBeforeSnapshotResponse: symbolEvents.filter((event) => event.receivedAtMs <= snapshotResult.completedAtMs).length,
        eventRatePerSecond: Number((symbolEvents.length / seconds).toFixed(2)),
        officialBridge: bridge(symbolEvents, officialIndex),
        currentPlusOneBridge: bridge(symbolEvents, currentIndex),
        bridgeSelectionDiffers: officialIndex !== currentIndex,
        officialChainPuMismatches: officialChain.mismatches,
        currentChainPuMismatches: currentChain.mismatches,
        firstOfficialChainMismatch: officialChain.first,
        firstCurrentChainMismatch: currentChain.first,
      };
    });
    const report = { generatedAt: new Date().toISOString(), readOnly: true, endpoint: 'USD-M Futures production public market data', symbols, snapshotLimit, preSnapshotBufferMs, postSnapshotObserveMs, durationMs: finishedAtMs - openedAtMs, audits };
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    ws.terminate();
  }
}

const hardTimer = setTimeout(() => {
  console.error(`audit hard timeout after ${hardTimeoutMs}ms`);
  process.exit(2);
}, hardTimeoutMs);
hardTimer.unref();

run().then(() => {
  clearTimeout(hardTimer);
  process.exit(0);
}).catch((error) => {
  clearTimeout(hardTimer);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
