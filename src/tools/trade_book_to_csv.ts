import fs from 'fs';
import path from 'path';
const dataDir = path.resolve(__dirname, '../../data');
const suffix = process.env.IS_TESTNET === '1' ? '_testnet' : '';
const jsonPath = path.join(dataDir, `orders_book${suffix}.json`);
const csvPath = path.join(dataDir, `orders_book${suffix}.csv`);

type SimplifiedRecord = {
  symbol: string;
  openedAt: string;
  strategy?: string;
  closedAt?: string;
  grossPnl?: number | null;
  commission?: number | null;
  netPnl?: number | null;
  closeReason?: string;
  filters?: Record<string, unknown> | string;
};

const HEADERS = [
  'symbol',
  'opened_at',
  'strategy',
  'closed_at',
  'gross_pnl',
  'commission',
  'net_pnl',
  'close_reason',
  'filters',
] as const;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toCsvLine(values: string[]): string {
  return values
    .map((value) => {
      const needsQuote = /[",\n]/.test(value);
      const safeValue = value.replace(/"/g, '""');
      return needsQuote ? `"${safeValue}"` : safeValue;
    })
    .join(',');
}

function ensureJsonExists() {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Trade book not found at ${jsonPath}. Run the bot to generate trades first.`);
  }
}

function loadSimplifiedBook(): SimplifiedRecord[] {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('orders_book.json does not contain an array of trades.');
  }
  return parsed as SimplifiedRecord[];
}

function writeCsv(entries: SimplifiedRecord[]) {
  const lines = [toCsvLine(HEADERS as unknown as string[])];
  for (const entry of entries) {
    const row = [
      formatCell(entry.symbol),
      formatCell(entry.openedAt),
      formatCell(entry.strategy),
      formatCell(entry.closedAt),
      formatCell(entry.grossPnl),
      formatCell(entry.commission),
      formatCell(entry.netPnl),
      formatCell(entry.closeReason),
      formatCell(entry.filters),
    ];
    lines.push(toCsvLine(row));
  }
  fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
}

async function main() {
  ensureJsonExists();
  const book = loadSimplifiedBook();
  if (!book.length) {
    console.log('No trades recorded yet.');
    return;
  }
  writeCsv(book);
  console.log(`CSV exported to ${csvPath}`);
}

main().catch((err) => {
  console.error('trade_book_export_fail', err);
  process.exitCode = 1;
});
