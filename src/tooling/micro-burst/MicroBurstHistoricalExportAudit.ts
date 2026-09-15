import { readFileSync } from 'node:fs';

export const AMBIGUOUS_SYMBOLS = [
  'SOLUSDT',
  'SUIUSDT',
  'LINKUSDT',
  'BNBUSDT',
  'LTCUSDT',
  'AVAXUSDT',
  'XRPUSDT',
  'DOGEUSDT',
] as const;

export type HistoricalExportRow = Record<string, unknown>;

export interface HistoricalExportAudit {
  readonly source: string;
  readonly symbols: Record<string, { rows: number; orderIds: string[]; clientOrderIds: string[] }>;
  readonly unsupportedRows: number;
  readonly malformedRows: number;
  readonly warnings: string[];
}

function rowsFromJson(value: unknown): HistoricalExportRow[] {
  if (Array.isArray(value)) return value.filter(isObject);
  if (isObject(value)) {
    for (const key of ['orders', 'trades', 'income', 'data', 'rows']) {
      if (Array.isArray(value[key])) return value[key].filter(isObject);
    }
  }
  return [];
}

function isObject(value: unknown): value is HistoricalExportRow {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseCsv(text: string): HistoricalExportRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((header) => header.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? '']));
  });
}

export function auditHistoricalExport(
  rows: readonly HistoricalExportRow[],
  source: string,
): HistoricalExportAudit {
  const symbols: HistoricalExportAudit['symbols'] = {};
  let unsupportedRows = 0;
  let malformedRows = 0;
  const warnings: string[] = [];
  for (const row of rows) {
    const symbol = String(row.symbol ?? row.Symbol ?? '').toUpperCase();
    if (!symbol) {
      malformedRows += 1;
      continue;
    }
    if (!(AMBIGUOUS_SYMBOLS as readonly string[]).includes(symbol)) {
      unsupportedRows += 1;
      continue;
    }
    const bucket = (symbols[symbol] ??= { rows: 0, orderIds: [], clientOrderIds: [] });
    bucket.rows += 1;
    const orderId = String(row.orderId ?? row.orderID ?? row.id ?? '').trim();
    const clientOrderId = String(row.clientOrderId ?? row.clientOrderID ?? '').trim();
    if (orderId && orderId !== 'undefined') bucket.orderIds.push(orderId);
    if (clientOrderId && clientOrderId !== 'undefined') bucket.clientOrderIds.push(clientOrderId);
  }
  for (const symbol of AMBIGUOUS_SYMBOLS) {
    if (!symbols[symbol]) warnings.push(`${symbol}: no matching rows in export`);
  }
  for (const bucket of Object.values(symbols)) {
    bucket.orderIds = [...new Set(bucket.orderIds)];
    bucket.clientOrderIds = [...new Set(bucket.clientOrderIds)];
  }
  return { source, symbols, unsupportedRows, malformedRows, warnings };
}

export function auditHistoricalExportFile(filePath: string): HistoricalExportAudit {
  const text = readFileSync(filePath, 'utf8');
  let rows: HistoricalExportRow[];
  try {
    rows = filePath.toLowerCase().endsWith('.csv')
      ? parseCsv(text)
      : rowsFromJson(JSON.parse(text));
  } catch {
    return {
      source: filePath,
      symbols: {},
      unsupportedRows: 0,
      malformedRows: 1,
      warnings: ['No se pudo interpretar el archivo como JSON o CSV'],
    };
  }
  return auditHistoricalExport(rows, filePath);
}
