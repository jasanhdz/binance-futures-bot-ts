import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AMBIGUOUS_SYMBOLS } from '../src/tooling/micro-burst/MicroBurstHistoricalExportAudit';

type JsonObject = Record<string, unknown>;

const evidencePath = process.argv[2];
const outputPath =
  process.argv[3] ?? '/tmp/opencode/micro-historical-reconciliation/reconciliation.json';
if (!evidencePath)
  throw new Error(
    'Uso: ts-node scripts/micro-burst-reconcile-historical.ts EVIDENCE_JSON [OUTPUT_JSON]',
  );

const evidence = JSON.parse(readFileSync(resolve(evidencePath), 'utf8')) as JsonObject;
const results = (evidence.results ?? {}) as JsonObject;
const symbols = Object.fromEntries(
  AMBIGUOUS_SYMBOLS.map((symbol) => {
    const state = readLocalState(symbol);
    const result = (results[symbol] ?? {}) as JsonObject;
    const orders = array(result.orders);
    const trades = array(result.trades);
    const income = array(result.income);
    const algoOrders = array(result.algoOrders);
    const reasons: string[] = [];
    if (!state) reasons.push('LOCAL_STATE_MISSING');
    if (state?.marketOpenAmbiguous !== true) reasons.push('LOCAL_AMBIGUITY_FLAG_NOT_PRESENT');
    if (orders.length === 0) reasons.push('NO_HISTORICAL_ORDERS');
    if (trades.length === 0) reasons.push('NO_HISTORICAL_TRADES');
    if (income.length === 0) reasons.push('NO_HISTORICAL_INCOME');
    if (![result.orders, result.trades, result.income, result.algoOrders].every(isCompletePageSet))
      reasons.push('RESPONSE_REMAINS_AT_PAGE_LIMIT');
    if (state?.positionOwner === 'EXTERNAL') reasons.push('LOCAL_IDENTITY_IS_EXTERNAL');
    if (!state?.lastOrderId) reasons.push('LOCAL_ENTRY_ORDER_ID_MISSING');
    const localOrderMatches = state?.lastOrderId
      ? orders.filter((row) => String(row.orderId ?? '') === String(state.lastOrderId))
      : [];
    if (state?.lastOrderId && localOrderMatches.length === 0)
      reasons.push('LOCAL_ENTRY_ORDER_NOT_FOUND');
    return [
      symbol,
      {
        classification: classify(state, localOrderMatches, reasons),
        reasons,
        local: state
          ? {
              lastTradeId: state.lastTradeId,
              lastOrderId: state.lastOrderId ?? null,
              marketOpenAmbiguous: state.marketOpenAmbiguous === true,
              positionOwner: state.positionOwner ?? null,
              tradeOrigin: state.tradeOrigin ?? null,
            }
          : null,
        exchange: {
          orderCount: orders.length,
          tradeCount: trades.length,
          incomeCount: income.length,
          algoOrderCount: algoOrders.length,
          orderStatuses: unique(orders.map((row) => String(row.status ?? 'UNKNOWN'))),
          filledOrderCount: orders.filter((row) => row.status === 'FILLED').length,
          realizedPnl: sumNumbers(trades, 'realizedPnl'),
          commission: sumNumbers(trades, 'commission'),
          localEntryOrderMatches: localOrderMatches.length,
        },
      },
    ];
  }),
);
const report = {
  schema_id: 'micro-burst-historical-reconciliation-v1',
  evidence_path: evidencePath,
  classifications: symbols,
  policy: 'No state or journal is modified by this report.',
};
mkdirSync(dirname(resolve(outputPath)), { recursive: true, mode: 0o700 });
writeFileSync(resolve(outputPath), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));

function readLocalState(symbol: string): JsonObject | null {
  try {
    return JSON.parse(
      readFileSync(resolve(`data/state_PROD_AEGIS_STATE_JSON_${symbol}.json`), 'utf8'),
    ) as JsonObject;
  } catch {
    return null;
  }
}

function array(value: unknown): JsonObject[] {
  const rows = isPageSet(value) ? value.rows : value;
  return Array.isArray(rows)
    ? rows.filter((row): row is JsonObject => Boolean(row && typeof row === 'object'))
    : [];
}

function isPageSet(value: unknown): value is { rows: unknown[]; pages: number; complete: boolean } {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as JsonObject).rows));
}

function isCompletePageSet(value: unknown): boolean {
  return isPageSet(value) && value.complete === true;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sumNumbers(rows: JsonObject[], field: string): number {
  return rows.reduce((total, row) => {
    const value = Number(row[field]);
    return Number.isFinite(value) ? total + value : total;
  }, 0);
}

function classify(state: JsonObject | null, matches: JsonObject[], reasons: string[]): string {
  if (state?.marketOpenAmbiguous !== true) return 'INSUFFICIENT_EVIDENCE';
  if (matches.length > 1) return 'CONFLICTING';
  if (matches.length === 1 && reasons.length === 0) return 'RESOLVED';
  return 'INSUFFICIENT_EVIDENCE';
}
