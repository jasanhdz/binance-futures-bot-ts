import fs from 'node:fs';
import WebSocket from 'ws';

type DepthEvent = {
  e: 'depthUpdate';
  E: number;
  T: number;
  s: string;
  U: number;
  u: number;
  pu: number;
  b: [string, string][];
  a: [string, string][];
};

type BufferedEvent = DepthEvent & { receivedAtMs: number };

type Snapshot = {
  lastUpdateId: number;
  E?: number;
  T?: number;
  bids: [string, string][];
  asks: [string, string][];
};

type SymbolAudit = {
  symbol: string;
  snapshotLastUpdateId: number;
  snapshotLatencyMs: number;
  totalEvents: number;
  eventsBufferedBeforeSnapshotResponse: number;
  eventRatePerSecond: number;
  officialBridge: null | { index: number; U: number; u: number; pu: number };
  currentPlusOneBridge: null | { index: number; U: number; u: number; pu: number };
  bridgeSelectionDiffers: boolean;
  officialChainPuMismatches: number;
  currentChainPuMismatches: number;
  firstOfficialChainMismatch: null | { index: number; expectedPu: number; actualPu: number; U: number; u: number };
  firstCurrentChainMismatch: null | { index: number; expectedPu: number; actualPu: number; U: number; u: number };
};

const symbols = (process.env.ORDER_BOOK_AUDIT_SYMBOLS ?? 'BTCUSDT,ETHUSDT')
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const preSnapshotBufferMs = Number(process.env.ORDER_BOOK_AUDIT_PRE_SNAPSHOT_MS ?? 750);
const postSnapshotObserveMs = Number(process.env.ORDER_BOOK_AUDIT_POST_SNAPSHOT_MS ?? 4_000);
const snapshotLimit = Number(process.env.ORDER_BOOK_AUDIT_SNAPSHOT_LIMIT ?? 1_000);
const outputPath = process.env.ORDER_BOOK_AUDIT_OUTPUT ?? 'order-book-protocol-audit.json';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertFiniteSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${label}: ${String(value)}`);
  }
}

async function fetchSnapshot(symbol: string): Promise<{ snapshot: Snapshot; latencyMs: number; completedAtMs: number }> {
  const startedAtMs = Date.now();
  const response = await fetch(
    `https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${snapshotLimit}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) throw new Error(`${symbol} snapshot HTTP ${response.status}`);
  const snapshot = (await response.json()) as Snapshot;
  assertFiniteSafeInteger(snapshot.lastUpdateId, `${symbol}.lastUpdateId`);
  const completedAtMs = Date.now();
  return { snapshot, latencyMs: completedAtMs - startedAtMs, completedAtMs };
}

function findOfficialBridge(events: BufferedEvent[], lastUpdateId: number): number {
  // USD-M Futures official rule: discard u < lastUpdateId; first applicable event
  // must contain lastUpdateId in [U, u].
  return events.findIndex(
    (event) => event.u >= lastUpdateId && event.U <= lastUpdateId && lastUpdateId <= event.u,
  );
}

function findCurrentPlusOneBridge(events: BufferedEvent[], lastUpdateId: number): number {
  const boundary = lastUpdateId + 1;
  return events.findIndex(
    (event) => event.u >= boundary && event.U <= boundary && boundary <= event.u,
  );
}

function bridgeSummary(events: BufferedEvent[], index: number): SymbolAudit['officialBridge'] {
  if (index < 0) return null;
  const event = events[index];
  return { index, U: event.U, u: event.u, pu: event.pu };
}

function inspectPuChain(
  events: BufferedEvent[],
  bridgeIndex: number,
): { mismatches: number; firstMismatch: SymbolAudit['firstOfficialChainMismatch'] } {
  if (bridgeIndex < 0) return { mismatches: 0, firstMismatch: null };
  let previousU = events[bridgeIndex].u;
  let mismatches = 0;
  let firstMismatch: SymbolAudit['firstOfficialChainMismatch'] = null;
  for (let index = bridgeIndex + 1; index < events.length; index++) {
    const event = events[index];
    if (event.u <= previousU) continue;
    if (event.pu !== previousU) {
      mismatches++;
      if (!firstMismatch) {
        firstMismatch = { index, expectedPu: previousU, actualPu: event.pu, U: event.U, u: event.u };
      }
    }
    previousU = event.u;
  }
  return { mismatches, firstMismatch };
}

async function main(): Promise<void> {
  if (symbols.length < 1 || symbols.length > 4) throw new Error('audit supports 1-4 symbols');
  const streams = symbols.map((symbol) => `${symbol.toLowerCase()}@depth@100ms`).join('/');
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  const events = new Map<string, BufferedEvent[]>(symbols.map((symbol) => [symbol, []]));
  const openedAtMs = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 15_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(Date.now());
    });
    ws.once('error', reject);
  });

  ws.on('message', (raw) => {
    const parsed = JSON.parse(raw.toString()) as { stream?: string; data?: DepthEvent } | DepthEvent;
    const event = 'data' in parsed && parsed.data ? parsed.data : (parsed as DepthEvent);
    if (!event?.s || event.e !== 'depthUpdate') return;
    if (![event.U, event.u, event.pu, event.E, event.T].every(Number.isSafeInteger)) return;
    const symbol = event.s.toUpperCase();
    events.get(symbol)?.push({ ...event, receivedAtMs: Date.now() });
  });

  await sleep(preSnapshotBufferMs);
  const snapshots = new Map(
    await Promise.all(
      symbols.map(async (symbol) => [symbol, await fetchSnapshot(symbol)] as const),
    ),
  );
  await sleep(postSnapshotObserveMs);
  ws.close();

  const finishedAtMs = Date.now();
  const audits: SymbolAudit[] = symbols.map((symbol) => {
    const symbolEvents = events.get(symbol) ?? [];
    const snapshotResult = snapshots.get(symbol);
    if (!snapshotResult) throw new Error(`missing snapshot result for ${symbol}`);
    const { snapshot, latencyMs, completedAtMs } = snapshotResult;
    const officialIndex = findOfficialBridge(symbolEvents, snapshot.lastUpdateId);
    const currentIndex = findCurrentPlusOneBridge(symbolEvents, snapshot.lastUpdateId);
    const officialChain = inspectPuChain(symbolEvents, officialIndex);
    const currentChain = inspectPuChain(symbolEvents, currentIndex);
    const bufferedBeforeSnapshotResponse = symbolEvents.filter((event) => event.receivedAtMs <= completedAtMs).length;
    const seconds = Math.max(0.001, (finishedAtMs - openedAtMs) / 1_000);
    return {
      symbol,
      snapshotLastUpdateId: snapshot.lastUpdateId,
      snapshotLatencyMs: latencyMs,
      totalEvents: symbolEvents.length,
      eventsBufferedBeforeSnapshotResponse: bufferedBeforeSnapshotResponse,
      eventRatePerSecond: Number((symbolEvents.length / seconds).toFixed(2)),
      officialBridge: bridgeSummary(symbolEvents, officialIndex),
      currentPlusOneBridge: bridgeSummary(symbolEvents, currentIndex),
      bridgeSelectionDiffers: officialIndex !== currentIndex,
      officialChainPuMismatches: officialChain.mismatches,
      currentChainPuMismatches: currentChain.mismatches,
      firstOfficialChainMismatch: officialChain.firstMismatch,
      firstCurrentChainMismatch: currentChain.firstMismatch,
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    endpoint: 'USD-M Futures production public market data',
    symbols,
    snapshotLimit,
    preSnapshotBufferMs,
    postSnapshotObserveMs,
    durationMs: finishedAtMs - openedAtMs,
    audits,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
