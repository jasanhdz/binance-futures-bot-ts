import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Binance from 'binance-api-node';
import { CONFIG } from '../infra/config';

type CliArgs = {
  start: Date;
  end: Date;
  symbols: string[];
  jsonPath?: string;
  csvPath?: string;
  includeOrders: boolean;
};

type RawTrade = {
  symbol: string;
  orderId: number;
  id: number;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  maker: boolean;
  buyer: boolean;
  time: number;
  positionSide?: 'LONG' | 'SHORT' | 'BOTH';
};

type Operation = {
  symbol: string;
  orderId: number;
  startTime: number;
  endTime: number;
  side: 'BUY' | 'SELL';
  positionSide?: 'LONG' | 'SHORT' | 'BOTH';
  realizedPnl: number;
  commission: number;
  volume: number;
  trades: RawTrade[];
  clientOrderId?: string;
};

type SummaryRow = {
  label: string;
  total: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  avgPnl: number;
  netPnl: number;
  firstTime: number;
  lastTime: number;
};

const MS_IN_DAY = 24 * 60 * 60 * 1000;
const EPSILON = 1e-8;

function printUsage(): void {
  console.log(`Usage: npm run report:accuracy -- [options]

Options:
  --from=YYYY-MM-DDTHH:MM   Start datetime (ISO). Defaults to yesterday 00:00 (local).
  --to=YYYY-MM-DDTHH:MM     End datetime (ISO).   Defaults to now.
  --symbols=SYM1,SYM2       Override symbol list (defaults to CONFIG.SYMBOLS or CONFIG.SYMBOL).
  --json=path               Write full JSON report (operations + summary).
  --csv=path                Write summary table (per symbol) to CSV.
  --include-orders          Fetch clientOrderId for each operation (extra API calls).
  --help                    Show this help and exit.
`);
}

function parseOption(argv: string[], name: string): string | undefined {
  const long = `--${name}`;
  for (const token of argv) {
    if (token.startsWith(`${long}=`)) {
      return token.slice(long.length + 1);
    }
  }
  const idx = argv.indexOf(long);
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return undefined;
}

function parseFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(`Ignoring invalid date "${value}". Expected ISO format (e.g. 2025-02-14T00:00).`);
    return undefined;
  }
  return parsed;
}

function defaultRange(): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date(end.getTime() - MS_IN_DAY);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

function parseSymbols(raw?: string): string[] {
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
  }
  if (CONFIG.SYMBOLS && CONFIG.SYMBOLS.length) {
    return CONFIG.SYMBOLS;
  }
  return [CONFIG.SYMBOL];
}

function parseCliArgs(): CliArgs {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    printUsage();
    process.exit(0);
  }
  const defaults = defaultRange();
  const start = parseDate(parseOption(argv, 'from') ?? parseOption(argv, 'start')) ?? defaults.start;
  const end = parseDate(parseOption(argv, 'to') ?? parseOption(argv, 'end')) ?? defaults.end;
  if (end.getTime() < start.getTime()) {
    throw new Error('End datetime must be after start datetime.');
  }
  const symbols = parseSymbols(parseOption(argv, 'symbols'));
  if (!symbols.length) {
    throw new Error('No symbols resolved; pass --symbols or configure SYMBOL/SYMBOLS env vars.');
  }
  const jsonPath = parseOption(argv, 'json');
  const csvPath = parseOption(argv, 'csv');
  const includeOrders = parseFlag(argv, 'include-orders');
  return { start, end, symbols, jsonPath, csvPath, includeOrders };
}

async function fetchTradesForSymbol(
  client: ReturnType<typeof Binance>,
  symbol: string,
  startTime: number,
  endTime: number,
): Promise<RawTrade[]> {
  const trades: RawTrade[] = [];
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
      if (t.time < startTime || t.time > endTime) continue;
      trades.push({
        symbol,
        orderId: t.orderId,
        id: t.id,
        side: t.side,
        price: Number(t.price),
        qty: Number(t.qty),
        realizedPnl: Number(t.realizedPnl ?? 0),
        commission: Number(t.commission ?? 0),
        commissionAsset: t.commissionAsset ?? 'USDT',
        maker: Boolean(t.maker),
        buyer: Boolean(t.buyer),
        time: t.time,
        positionSide: (t.positionSide as any) ?? undefined,
      });
    }
    if (batch.length < 1000) break;
    fromId = batch[batch.length - 1].id + 1;
  }

  trades.sort((a, b) => a.time - b.time);
  return trades;
}

function aggregateOperations(trades: RawTrade[]): Operation[] {
  const map = new Map<string, Operation>();
  for (const trade of trades) {
    const key = `${trade.symbol}-${trade.orderId}`;
    let op = map.get(key);
    if (!op) {
      op = {
        symbol: trade.symbol,
        orderId: trade.orderId,
        startTime: trade.time,
        endTime: trade.time,
        side: trade.side,
        positionSide: trade.positionSide,
        realizedPnl: 0,
        commission: 0,
        volume: 0,
        trades: [],
      };
      map.set(key, op);
    }
    op.startTime = Math.min(op.startTime, trade.time);
    op.endTime = Math.max(op.endTime, trade.time);
    op.side = trade.side;
    if (trade.positionSide) op.positionSide = trade.positionSide;
    op.realizedPnl += trade.realizedPnl;
    op.commission += trade.commission;
    op.volume += trade.qty;
    op.trades.push(trade);
  }
  return Array.from(map.values()).sort((a, b) => a.startTime - b.startTime);
}

async function enrichClientOrderIds(
  client: ReturnType<typeof Binance>,
  operations: Operation[],
): Promise<void> {
  const seen = new Set<string>();
  for (const op of operations) {
    const cacheKey = `${op.symbol}-${op.orderId}`;
    if (seen.has(cacheKey)) continue;
    try {
      const order = await client.futuresGetOrder({ symbol: op.symbol, orderId: op.orderId });
      if (order?.clientOrderId) {
        op.clientOrderId = order.clientOrderId;
      }
    } catch (err: any) {
      console.warn('order_lookup_failed', {
        symbol: op.symbol,
        orderId: op.orderId,
        error: err?.message || String(err),
      });
    }
    seen.add(cacheKey);
  }
}

function initSummary(label: string): SummaryRow {
  return {
    label,
    total: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: 0,
    avgPnl: 0,
    netPnl: 0,
    firstTime: Number.POSITIVE_INFINITY,
    lastTime: Number.NEGATIVE_INFINITY,
  };
}

function accumulateSummary(row: SummaryRow, pnl: number, startTime: number, endTime: number) {
  row.total += 1;
  row.netPnl += pnl;
  if (pnl > EPSILON) row.wins += 1;
  else if (pnl < -EPSILON) row.losses += 1;
  else row.breakeven += 1;
  row.firstTime = Math.min(row.firstTime, startTime);
  row.lastTime = Math.max(row.lastTime, endTime);
}

function finalizeSummary(row: SummaryRow) {
  if (row.total > 0) {
    row.winRate = Number(((row.wins / row.total) * 100).toFixed(2));
    row.avgPnl = Number((row.netPnl / row.total).toFixed(6));
  } else {
    row.winRate = 0;
    row.avgPnl = 0;
  }
  row.netPnl = Number(row.netPnl.toFixed(6));
  if (!Number.isFinite(row.firstTime)) row.firstTime = NaN;
  if (!Number.isFinite(row.lastTime)) row.lastTime = NaN;
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main() {
  const { start, end, symbols, jsonPath, csvPath, includeOrders } = parseCliArgs();
  const startTime = start.getTime();
  const endTime = end.getTime();

  const client = Binance({
    apiKey: CONFIG.API_KEY || undefined,
    apiSecret: CONFIG.API_SECRET || undefined,
    httpFutures: CONFIG.HTTP_FUTURES,
    wsFutures: CONFIG.WS_FUTURES,
  });

  const allOperations: Operation[] = [];
  let totalTrades = 0;

  for (const symbol of symbols) {
    try {
      const trades = await fetchTradesForSymbol(client, symbol, startTime, endTime);
      totalTrades += trades.length;
      const operations = aggregateOperations(trades);
      allOperations.push(...operations);
    } catch (err: any) {
      console.warn('trade_fetch_failed', { symbol, error: err?.message || String(err) });
    }
  }

  if (!allOperations.length) {
    console.log('No operations found in the requested window.');
    return;
  }

  if (includeOrders) {
    await enrichClientOrderIds(client, allOperations);
  }

  const bySymbol = new Map<string, SummaryRow>();
  const summaries: SummaryRow[] = [];

  for (const op of allOperations) {
    const row = bySymbol.get(op.symbol) ?? initSummary(op.symbol);
    accumulateSummary(row, op.realizedPnl, op.startTime, op.endTime);
    bySymbol.set(op.symbol, row);
  }

  for (const row of bySymbol.values()) {
    finalizeSummary(row);
    summaries.push(row);
  }

  summaries.sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.total - a.total;
  });

  const formatter = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  console.log(
    `Fetched ${totalTrades} fills → ${allOperations.length} operations between ${formatter.format(
      start,
    )} and ${formatter.format(end)}.`,
  );

  console.log('\nWin rate by symbol:');
  console.table(
    summaries.map((row) => ({
      symbol: row.label,
      ops: row.total,
      wins: row.wins,
      losses: row.losses,
      breakeven: row.breakeven,
      winRatePct: row.winRate,
      avgPnL: row.avgPnl,
      netPnL: row.netPnl,
      firstAt: Number.isFinite(row.firstTime) ? new Date(row.firstTime).toISOString() : null,
      lastAt: Number.isFinite(row.lastTime) ? new Date(row.lastTime).toISOString() : null,
    })),
  );

  const top = summaries[0];
  if (top) {
    console.log(
      `\nTop symbol ${top.label}: ${top.winRate}% win rate over ${top.total} operations (net PnL ${top.netPnl}).`,
    );
  }

  if (jsonPath) {
    ensureDir(jsonPath);
    const report = {
      generatedAt: new Date().toISOString(),
      start: start.toISOString(),
      end: end.toISOString(),
      symbols,
      operations: allOperations.map((op) => ({
        symbol: op.symbol,
        orderId: op.orderId,
        startTime: new Date(op.startTime).toISOString(),
        endTime: new Date(op.endTime).toISOString(),
        side: op.side,
        positionSide: op.positionSide ?? null,
        realizedPnl: Number(op.realizedPnl.toFixed(6)),
        commission: Number(op.commission.toFixed(6)),
        volume: Number(op.volume.toFixed(6)),
        trades: op.trades.map((t) => ({
          id: t.id,
          side: t.side,
          price: t.price,
          qty: t.qty,
          realizedPnl: Number(t.realizedPnl.toFixed(6)),
          commission: Number(t.commission.toFixed(6)),
          time: new Date(t.time).toISOString(),
          buyer: t.buyer,
          maker: t.maker,
          positionSide: t.positionSide ?? null,
        })),
        clientOrderId: op.clientOrderId ?? null,
      })),
      summary: summaries,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nFull JSON report saved to ${jsonPath}`);
  }

  if (csvPath) {
    ensureDir(csvPath);
    const lines = [
      [
        'symbol',
        'operations',
        'wins',
        'losses',
        'breakeven',
        'win_rate_pct',
        'avg_pnl',
        'net_pnl',
        'first_at',
        'last_at',
      ].join(','),
    ];
    for (const row of summaries) {
      const firstIso = Number.isFinite(row.firstTime) ? new Date(row.firstTime).toISOString() : '';
      const lastIso = Number.isFinite(row.lastTime) ? new Date(row.lastTime).toISOString() : '';
      lines.push(
        [
          row.label,
          row.total,
          row.wins,
          row.losses,
          row.breakeven,
          row.winRate,
          row.avgPnl,
          row.netPnl,
          firstIso,
          lastIso,
        ]
          .map((value) => {
            const stringValue = String(value ?? '');
            if (/[",\n]/.test(stringValue)) {
              return `"${stringValue.replace(/"/g, '""')}"`;
            }
            return stringValue;
          })
          .join(','),
      );
    }
    fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
    console.log(`Summary CSV saved to ${csvPath}`);
  }
}

main().catch((err) => {
  console.error('trade_accuracy_report_fail', err);
  process.exitCode = 1;
});
