import fs from 'fs';
import readline from 'readline';
import Table from 'cli-table3';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function parseKvPairs(fragment: string, row: Record<string, string>) {
  const regex = /([A-Za-z0-9_]+)=([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(fragment)) !== null) {
    const [, key, raw] = match;
    if (!row[key]) {
      row[key] = raw;
    }
  }
}

function parseLine(line: string): Record<string, string> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const payload = JSON.parse(trimmed);
      const row: Record<string, string> = {};
      if (payload.ts) row.time = formatValue(payload.ts);
      if (payload.level) row.level = formatValue(payload.level);
      if (payload.msg) row.msg = formatValue(payload.msg);
      if (payload.ctx && typeof payload.ctx === 'object') {
        for (const [key, value] of Object.entries(payload.ctx)) {
          if (row[key] === undefined) {
            row[key] = formatValue(value);
          }
        }
      }
      return row;
    } catch {
      // fallthrough to generic parsing
    }
  }

  const ampmMatch = trimmed.match(/^(\d{1,2}:\d{2}:\d{2}\s?(?:AM|PM))\s+([A-Za-z0-9_]+)\s*(.*)$/i);
  const twentyFourMatch = trimmed.match(/^(\d{1,2}:\d{2}:\d{2})\s+([A-Za-z0-9_]+)\s*(.*)$/);
  const match = ampmMatch || twentyFourMatch;
  if (match) {
    const [, time, msg, rest] = match;
    const row: Record<string, string> = { time, msg };
    if (rest) parseKvPairs(rest, row);
    return row;
  }

  // fallback: treat as raw line under `raw`
  return { raw: trimmed };
}

async function readLinesFromStdin(): Promise<string[]> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines;
}

async function loadLines(file?: string): Promise<string[]> {
  if (file) {
    const data = fs.readFileSync(file, 'utf8');
    return data.split(/\r?\n/);
  }
  if (!process.stdin.isTTY) {
    return readLinesFromStdin();
  }
  throw new Error('Provide --file or pipe log lines via stdin.');
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('file', {
      alias: 'f',
      type: 'string',
      describe: 'Log file to read (defaults to stdin)',
    })
    .option('columns', {
      alias: 'c',
      type: 'array',
      describe: 'Columns to display (comma separated or repeat --columns)',
    })
    .option('limit', {
      alias: 'n',
      type: 'number',
      describe: 'Limit number of rows displayed (from the end)',
    })
    .option('msg', {
      type: 'string',
      describe: 'Filter by message name (e.g. position_snapshot)',
    })
    .option('symbol', {
      type: 'string',
      describe: 'Filter by symbol (case-insensitive)',
    })
    .help()
    .parseSync();

  const lines = await loadLines(argv.file as string | undefined);
  const rows: Record<string, string>[] = [];
  const symbolFilter = argv.symbol ? String(argv.symbol).toUpperCase() : undefined;
  const msgFilter = argv.msg ? String(argv.msg) : undefined;

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    if (msgFilter && parsed.msg !== msgFilter) continue;

    if (symbolFilter) {
      const symbolValue = parsed.symbol || parsed.Symbol;
      if (!symbolValue || symbolValue.toUpperCase() !== symbolFilter) continue;
    }

    rows.push(parsed);
  }

  if (rows.length === 0) {
    console.log('No rows matched.');
    return;
  }

  let selectedRows = rows;
  if (argv.limit && argv.limit > 0 && rows.length > argv.limit) {
    selectedRows = rows.slice(-argv.limit);
  }

  let columns: string[];
  if (argv.columns && Array.isArray(argv.columns) && argv.columns.length) {
    columns = (argv.columns as string[]).map((c) => String(c));
  } else {
    const colSet = new Set<string>();
    for (const row of selectedRows) {
      Object.keys(row).forEach((key) => colSet.add(key));
    }
    const preferredOrder = [
      'time',
      'level',
      'msg',
      'symbol',
      'side',
      'entry',
      'mark',
      'vwap',
      'devPct',
      'rsi',
      'roiPct',
      'pnlUsd',
      'qtyAbs',
      'openMs',
    ];
    const dynamic = Array.from(colSet).filter((key) => !preferredOrder.includes(key));
    columns = [...preferredOrder.filter((key) => colSet.has(key)), ...dynamic.sort()];
  }

  const table = new Table({ head: columns });
  for (const row of selectedRows) {
    table.push(columns.map((col) => formatValue(row[col])));
  }

  console.log(table.toString());
}

main().catch((err) => {
  console.error('log_table_error', err);
  process.exitCode = 1;
});
