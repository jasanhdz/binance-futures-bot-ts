import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Binance from 'binance-api-node';
import { CONFIG } from '../infra/config';

type LocalOrder = {
  symbol: string;
  openedAt?: string;
  strategy?: string;
  closedAt?: string;
  grossPnl?: number | null;
  commission?: number | null;
  netPnl?: number | null;
  closeReason?: string;
  filters?: Record<string, unknown> | string;
  openedAtTs?: number | null;
  closedAtTs?: number | null;
};

type AuditTrade = {
  symbol: string;
  id: number;
  orderId: number;
  time: number;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  maker: boolean;
  matchedStrategy?: string;
  matchedOpenedAt?: string;
  matchedClosedAt?: string;
  matchedReason?: string;
  filters?: Record<string, unknown> | string;
  source: 'bot' | 'manual';
};

const dataDir = path.resolve(__dirname, '../../data');
const auditDir = path.join(dataDir, 'audit');
const suffix = process.env.IS_TESTNET === '1' ? '_testnet' : '';
const localBookPath = path.join(dataDir, `orders_book${suffix}.json`);

const START_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;
const MATCH_PAD_MS = 5 * 60 * 1000;

function ensureLocalBook(): LocalOrder[] {
  if (!fs.existsSync(localBookPath)) {
    throw new Error(`orders book not found at ${localBookPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(localBookPath, 'utf8')) as LocalOrder[];
  return raw.map((entry) => ({
    ...entry,
    openedAtTs: parseLocalTimestamp(entry.openedAt),
    closedAtTs: parseLocalTimestamp(entry.closedAt),
  }));
}

function parseLocalTimestamp(value?: string): number | null {
  if (!value) return null;
  // format: MM-DD-YYYY: HH:MM AM
  const match = value.match(
    /^(?<month>\d{2})-(?<day>\d{2})-(?<year>\d{4}): (?<hour>\d{2}):(?<minute>\d{2}) (?<ampm>AM|PM)$/i,
  );
  if (!match || !match.groups) return null;
  let hour = Number(match.groups.hour);
  if (!Number.isFinite(hour)) return null;
  if (match.groups.ampm?.toUpperCase() === 'PM' && hour < 12) hour += 12;
  if (match.groups.ampm?.toUpperCase() === 'AM' && hour === 12) hour = 0;
  const iso = `${match.groups.year}-${match.groups.month}-${match.groups.day}T${hour
    .toString()
    .padStart(2, '0')}:${match.groups.minute}:00Z`;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}

async function fetchTradesForSymbol(
  client: ReturnType<typeof Binance>,
  symbol: string,
  startTime: number,
  endTime: number,
): Promise<AuditTrade[]> {
  const trades: AuditTrade[] = [];
  let fromId: number | undefined;

  while (true) {
    const batch = await client.futuresUserTrades({
      symbol,
      startTime,
      endTime,
      limit: 1000,
      ...(fromId ? { fromId } : {}),
    });

    if (!batch.length) break;

    for (const t of batch) {
      if (t.time < startTime) continue;
      trades.push({
        symbol,
        id: t.id,
        orderId: t.orderId,
        time: t.time,
        side: t.side,
        price: Number(t.price),
        qty: Number(t.qty),
        realizedPnl: Number(t.realizedPnl ?? 0),
        commission: Number(t.commission ?? 0),
        commissionAsset: t.commissionAsset ?? 'USDT',
        maker: Boolean(t.maker),
        source: 'manual', // placeholder, updated later
      });
    }

    if (batch.length < 1000) break;
    const lastId = batch[batch.length - 1].id;
    fromId = lastId + 1;
  }

  return trades;
}

function matchTradeToLocal(trade: AuditTrade, locals: LocalOrder[]): LocalOrder | null {
  let best: LocalOrder | null = null;
  let bestDiff = Infinity;
  for (const order of locals) {
    if (order.symbol !== trade.symbol) continue;
    if (!order.openedAtTs || !order.closedAtTs) continue;
    const windowStart = order.openedAtTs - MATCH_PAD_MS;
    const windowEnd = order.closedAtTs + MATCH_PAD_MS;
    if (trade.time < windowStart || trade.time > windowEnd) continue;
    const diff = Math.min(
      Math.abs(trade.time - order.openedAtTs),
      Math.abs(trade.time - order.closedAtTs),
    );
    if (diff < bestDiff) {
      best = order;
      bestDiff = diff;
    }
  }
  return best;
}

async function main() {
  if (!CONFIG.SYMBOLS || !CONFIG.SYMBOLS.length) {
    throw new Error('No symbols configured; set SYMBOL or SYMBOLS env vars.');
  }

  const client = Binance({
    apiKey: CONFIG.API_KEY || undefined,
    apiSecret: CONFIG.API_SECRET || undefined,
    httpFutures: CONFIG.HTTP_FUTURES,
    wsFutures: CONFIG.WS_FUTURES,
  });

  const endTime = Date.now();
  const startTime = endTime - START_OFFSET_MS;

  const localOrders = ensureLocalBook();
  const trades: AuditTrade[] = [];

  for (const symbol of CONFIG.SYMBOLS) {
    try {
      const fetched = await fetchTradesForSymbol(client, symbol, startTime, endTime);
      trades.push(...fetched);
    } catch (err) {
      console.warn('audit_fetch_fail', { symbol, err: (err as any)?.message || String(err) });
    }
  }

  const localsBySymbol = new Map<string, LocalOrder[]>();
  for (const order of localOrders) {
    if (!localsBySymbol.has(order.symbol)) localsBySymbol.set(order.symbol, []);
    localsBySymbol.get(order.symbol)!.push(order);
  }

  let matchedCount = 0;
  for (const trade of trades) {
    const candidates = localsBySymbol.get(trade.symbol) ?? [];
    const matched = matchTradeToLocal(trade, candidates);
    if (matched) {
      trade.matchedStrategy = matched.strategy;
      trade.matchedOpenedAt = matched.openedAt;
      trade.matchedClosedAt = matched.closedAt;
      trade.matchedReason = matched.closeReason;
      trade.filters = matched.filters;
      trade.source = 'bot';
      matchedCount += 1;
    }
  }

  trades.sort((a, b) => a.time - b.time);

  const summary = trades.reduce(
    (acc, trade) => {
      const key = trade.matchedStrategy ?? 'manual/unknown';
      acc.counts[key] = (acc.counts[key] || 0) + 1;
      acc.realizedPnl[key] = (acc.realizedPnl[key] || 0) + trade.realizedPnl;
      return acc;
    },
    { counts: {} as Record<string, number>, realizedPnl: {} as Record<string, number> },
  );

  const barSeries = Object.entries(summary.counts).map(([strategy, count]) => ({
    strategy,
    count,
    realizedPnl: Number((summary.realizedPnl[strategy] || 0).toFixed(6)),
  }));

  const tableRows = trades.map((trade) => ({
    symbol: trade.symbol,
    time: new Date(trade.time).toISOString(),
    side: trade.side,
    price: trade.price,
    qty: trade.qty,
    realizedPnl: trade.realizedPnl,
    commission: trade.commission,
    source: trade.source,
    strategy: trade.matchedStrategy ?? 'manual/unknown',
    openedAt: trade.matchedOpenedAt,
    closedAt: trade.matchedClosedAt,
    closeReason: trade.matchedReason,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    startTime,
    endTime,
    totalTrades: trades.length,
    matchedTrades: matchedCount,
    unmatchedTrades: trades.length - matchedCount,
    summary,
    tableRows,
    barSeries,
    trades,
  };

  fs.mkdirSync(auditDir, { recursive: true });
  const file = path.join(
    auditDir,
    `order-audit-${new Date().toISOString().replace(/[:]/g, '-')}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');

  console.log(
    `Audit complete: ${trades.length} trades (${matchedCount} matched). JSON saved to ${file}`,
  );

  // Simple console tables for quick inspection
  console.log('\nTop strategies by trade count:');
  console.table(
    barSeries
      .sort((a, b) => b.count - a.count)
      .map((row) => ({ Strategy: row.strategy, Trades: row.count, RealizedPnl: row.realizedPnl })),
  );

  console.log('\nRecent trades sample:');
  console.table(tableRows.slice(-10));
}

main().catch((err) => {
  console.error('order_audit_fail', err);
  process.exitCode = 1;
});
