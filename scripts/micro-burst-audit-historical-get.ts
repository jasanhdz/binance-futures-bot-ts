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

const client = new BinanceUsdmReadOnlyAuditClient({
  apiKey: process.env.BINANCE_API_KEY ?? process.env.API_KEY ?? '',
  apiSecret: process.env.BINANCE_API_SECRET ?? process.env.API_SECRET ?? '',
  mode: AUDIT_MODE,
});
const results: Record<string, unknown> = {};
for (const symbol of symbols) {
  results[symbol] = {
    orders: (await client.getHistoricalOrders(symbol, startTime, endTime)).value,
    trades: (await client.getHistoricalUserTrades(symbol, startTime, endTime)).value,
    income: (await client.getHistoricalIncome(symbol, startTime, endTime)).value,
    algoOrders: (await client.getHistoricalAlgoOrders(symbol, startTime, endTime)).value,
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
