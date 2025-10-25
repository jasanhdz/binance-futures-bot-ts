import fs from 'fs';
import path from 'path';
import { loadTradeBook, TradeRecord } from '../core/analytics/trade_book';

const dataDir = path.resolve(__dirname, '../../data');
const suffix = process.env.IS_TESTNET === '1' ? '_testnet' : '';
const jsonPath = path.join(dataDir, `orders_book${suffix}.json`);
const csvPath = path.join(dataDir, `orders_book${suffix}.csv`);

const HEADERS: Array<keyof TradeRecord | 'net_profit'> = [
  'id',
  'symbol',
  'strategy',
  'side',
  'status',
  'close_reason',
  'entry_time',
  'close_time',
  'entry_price',
  'exit_price',
  'used_balance',
  'wallet_before',
  'wallet_after',
  'net_profit',
  'roi_pct',
  'commission_cost',
  'commission_estimate',
  'qty',
  'order_id',
  'exit_qty',
  'close_order_ids',
  'realized_pnl',
  'commission_asset',
  'filters',
];

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

async function ensureJsonExists() {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Trade book not found at ${jsonPath}. Run the bot to generate trades first.`);
  }
}

async function writeCsv(book: TradeRecord[]) {
  const lines = [toCsvLine(HEADERS as string[])];
  for (const entry of book) {
    const row = HEADERS.map((key) =>
      key === 'net_profit'
        ? formatCell(entry.net_profit ?? (entry.wallet_after ?? 0) - entry.wallet_before)
        : formatCell((entry as any)[key]),
    );
    lines.push(toCsvLine(row));
  }
  fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
}

async function main() {
  await ensureJsonExists();
  const book = loadTradeBook();
  if (!book.length) {
    console.log('No trades recorded yet.');
    return;
  }
  await writeCsv(book);
  console.log(`CSV exported to ${csvPath}`);
}

main().catch((err) => {
  console.error('trade_book_export_fail', err);
  process.exitCode = 1;
});
