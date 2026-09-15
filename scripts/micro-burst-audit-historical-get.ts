import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUDIT_MODE,
  BinanceUsdmReadOnlyAuditClient,
} from '../src/tooling/audit/binance-usdm-readonly/binance-usdm-readonly-audit-client';
import { AMBIGUOUS_SYMBOLS } from '../src/tooling/micro-burst/MicroBurstHistoricalExportAudit';

const [symbolsArg, fromArg, toArg, outputArg = '/tmp/opencode/micro-historical-get-audit'] =
  process.argv.slice(2);
const symbols = (symbolsArg ?? AMBIGUOUS_SYMBOLS.join(','))
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter((symbol) => (AMBIGUOUS_SYMBOLS as readonly string[]).includes(symbol));
const startTime = Date.parse(fromArg ?? '2026-05-01T00:00:00.000Z');
const endTime = Date.parse(toArg ?? new Date().toISOString());
if (
  symbols.length === 0 ||
  !Number.isFinite(startTime) ||
  !Number.isFinite(endTime) ||
  endTime <= startTime
) {
  throw new Error(
    'Uso: ts-node scripts/micro-burst-audit-historical-get.ts SYMBOLS FROM_ISO TO_ISO [OUTPUT_DIR]',
  );
}

async function main(): Promise<void> {
  const client = new BinanceUsdmReadOnlyAuditClient({
    apiKey: process.env.BINANCE_API_KEY ?? process.env.API_KEY ?? '',
    apiSecret: process.env.BINANCE_API_SECRET ?? process.env.API_SECRET ?? '',
    mode: AUDIT_MODE,
  });
  const results: Record<string, unknown> = {};
  for (const symbol of symbols) {
    results[symbol] = {
      orders: await fetchPages(
        (from, to) => client.getHistoricalOrders(symbol, from, to),
        startTime,
        endTime,
        ['time', 'updateTime'],
      ),
      trades: await fetchPages(
        (from, to) => client.getHistoricalUserTrades(symbol, from, to),
        startTime,
        endTime,
        ['time'],
      ),
      income: await fetchPages(
        (from, to) => client.getHistoricalIncome(symbol, from, to),
        startTime,
        endTime,
        ['time'],
      ),
      algoOrders: await fetchPages(
        (from, to) => client.getHistoricalAlgoOrders(symbol, from, to),
        startTime,
        endTime,
        ['createTime', 'updateTime'],
      ),
    };
  }
  const outputRoot = resolve(outputArg);
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(outputRoot, 'historical_get_evidence.json'),
    JSON.stringify(
      {
        schema_id: 'micro-burst-historical-get-evidence-v1',
        symbols,
        from: new Date(startTime).toISOString(),
        to: new Date(endTime).toISOString(),
        results,
        network_counters: client.counters,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ outputRoot, symbols, network_counters: client.counters }, null, 2));
}

async function fetchPages(
  request: (startTime: number, endTime: number) => Promise<{ value: unknown }>,
  startTime: number,
  endTime: number,
  timestampFields: readonly string[],
): Promise<{ rows: unknown[]; pages: number; complete: boolean }> {
  const rows: unknown[] = [];
  let pageStart = startTime;
  let pages = 0;
  for (let page = 0; page < 20 && pageStart <= endTime; page += 1) {
    pages += 1;
    const value = await request(pageStart, endTime);
    if (!Array.isArray(value.value)) return { rows, pages, complete: false };
    rows.push(...value.value);
    if (value.value.length < 1000) return { rows, pages, complete: true };
    const timestamps = value.value
      .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
      .map((row) => timestampFields.map((field) => Number(row[field])).find(Number.isFinite))
      .filter((timestamp): timestamp is number => timestamp !== undefined);
    const latest = Math.max(...timestamps);
    if (!Number.isFinite(latest) || latest < pageStart) return { rows, pages, complete: false };
    pageStart = latest + 1;
  }
  return { rows, pages, complete: pageStart > endTime };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'MICRO_HISTORICAL_GET_AUDIT_FAILED');
  process.exit(1);
});
