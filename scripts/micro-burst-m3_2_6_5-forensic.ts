import Database from 'better-sqlite3';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const runRoot = resolve(
  root,
  'data/micro-burst/soaks/m3_2_6_final/20260828012014923-baed55f5b10e',
);
const output = resolve(root, 'reports/micro-burst/m3_2_6_5_aggtrade_gap_forensics.csv');
mkdirSync(resolve(root, 'reports/micro-burst'), { recursive: true });

type Trade = {
  symbol: string;
  eventTime: number;
  receivedAtMs: number;
  aggregateTradeId?: number;
  firstTradeId?: number;
  lastTradeId?: number;
};

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  });
}

const trades: Trade[] = [];
for (const file of listFiles(resolve(runRoot, 'archive')).filter((file) => file.endsWith('.ndjson.gz'))) {
  const text = gunzipSync(readFileSync(file)).toString('utf8');
  for (const line of text.split('\n').filter(Boolean)) {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type !== 'trades') continue;
    const payload = (value.payload ?? value) as Record<string, unknown>;
    trades.push({
      symbol: String(payload.symbol),
      eventTime: Number(payload.eventTime),
      receivedAtMs: Number(payload.receivedAtMs),
      aggregateTradeId:
        typeof payload.aggregateTradeId === 'number' ? payload.aggregateTradeId : undefined,
      firstTradeId: typeof payload.firstTradeId === 'number' ? payload.firstTradeId : undefined,
      lastTradeId: typeof payload.lastTradeId === 'number' ? payload.lastTradeId : undefined,
    });
  }
}

const db = new Database(resolve(runRoot, 'research.sqlite'), { readonly: true });
const gaps = db
  .prepare(
    `SELECT symbol, started_at_ms, ended_at_ms, details_json
       FROM market_data_gaps
      WHERE gap_kind = 'AGG_TRADE_SEQUENCE'
      ORDER BY symbol, started_at_ms, id`,
  )
  .all() as Array<{
  symbol: string;
  started_at_ms: number;
  ended_at_ms: number;
  details_json: string;
}>;
db.close();

const escape = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`;
const header = [
  'symbol',
  'previous_aggregate_trade_id',
  'next_aggregate_trade_id',
  'aggregate_trade_id_delta',
  'previous_first_trade_id',
  'previous_last_trade_id',
  'next_first_trade_id',
  'next_last_trade_id',
  'event_time_previous',
  'event_time_next',
  'received_at_previous',
  'received_at_next',
  'raw_id_gap_size',
  'classification',
];
const rows: string[] = [header.join(',')];
const summary = new Map<string, number>();

for (const gap of gaps) {
  const details = JSON.parse(gap.details_json) as {
    previousTradeId: number;
    nextTradeId: number;
  };
  const previous = trades
    .filter((trade) => trade.symbol === gap.symbol && trade.lastTradeId === details.previousTradeId)
    .sort((a, b) => b.receivedAtMs - a.receivedAtMs)[0];
  const next = trades
    .filter((trade) => trade.symbol === gap.symbol && trade.firstTradeId === details.nextTradeId)
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs)[0];
  const aggregateDelta =
    previous?.aggregateTradeId !== undefined && next?.aggregateTradeId !== undefined
      ? next.aggregateTradeId - previous.aggregateTradeId
      : null;
  const classification =
    aggregateDelta === 1
      ? 'AGG_ID_CONTINUOUS_RAW_ID_GAP'
      : aggregateDelta !== null && aggregateDelta > 1
        ? 'AGG_ID_GAP'
        : previous && next && next.receivedAtMs < previous.receivedAtMs
          ? 'OUT_OF_ORDER'
          : previous?.aggregateTradeId === next?.aggregateTradeId
            ? 'DUPLICATE'
            : 'UNKNOWN';
  summary.set(`${gap.symbol}:${classification}`, (summary.get(`${gap.symbol}:${classification}`) ?? 0) + 1);
  rows.push(
    [
      gap.symbol,
      previous?.aggregateTradeId,
      next?.aggregateTradeId,
      aggregateDelta,
      previous?.firstTradeId,
      previous?.lastTradeId,
      next?.firstTradeId,
      next?.lastTradeId,
      previous?.eventTime,
      next?.eventTime,
      previous?.receivedAtMs,
      next?.receivedAtMs,
      details.nextTradeId - details.previousTradeId - 1,
      classification,
    ]
      .map(escape)
      .join(','),
  );
}

createWriteStream(output, { encoding: 'utf8' }).end(rows.join('\n') + '\n');
console.log(JSON.stringify({ total: gaps.length, summary: Object.fromEntries(summary) }, null, 2));
