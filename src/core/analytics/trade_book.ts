import fs from 'fs';
import path from 'path';
import { Side } from '../types';

const dataDir = path.resolve(__dirname, '../../../data');
const suffix = process.env.IS_TESTNET === '1' ? '_testnet' : '';
const bookPath = path.join(dataDir, `orders_book${suffix}.json`);

function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

export type TradeStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';
export type TradeFilters = Record<string, unknown>;

export type TradeRecord = {
  id: string;
  symbol: string;
  strategy: string;
  side: Side;
  entry_time: string;
  close_time?: string;
  entry_price: number;
  exit_price?: number;
  used_balance: number;
  wallet_before: number;
  wallet_after?: number;
  roi_pct?: number;
  net_profit?: number;
  commission_cost?: number;
  commission_estimate?: number;
  filters: TradeFilters;
  status: TradeStatus;
  qty?: number;
  order_id?: string;
  close_reason?: string;
  close_order_ids?: string[];
  exit_qty?: number;
  realized_pnl?: number;
  commission_asset?: string;
  outcome?: 'win' | 'loss';
};

export type TradeOpenPayload = {
  symbol: string;
  strategy: string;
  side: Side;
  entryTime: number | string | Date;
  entryPrice: number;
  usedBalance: number;
  walletBefore: number;
  filters?: TradeFilters;
  qty?: number;
  orderId?: string;
  commissionEstimate?: number;
  id?: string;
};

export type TradeClosePayload = {
  id?: string;
  symbol: string;
  closeTime?: number | string | Date;
  exitPrice?: number;
  walletAfter?: number;
  commissionCost?: number;
  status?: TradeStatus;
  closeReason?: string;
  exitQty?: number;
  closeOrderIds?: string[];
  realizedPnl?: number;
  commissionAsset?: string;
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatTimestamp(input?: number | string | Date): string {
  let date: Date;
  if (input instanceof Date) {
    date = input;
  } else if (typeof input === 'number' && Number.isFinite(input)) {
    date = new Date(input);
  } else if (typeof input === 'string' && input.trim().length) {
    const parsed = new Date(input);
    date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  } else {
    date = new Date();
  }

  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const year = date.getFullYear();

  let hours = date.getHours();
  const minutes = pad2(date.getMinutes());
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const hourStr = hours < 10 ? `0${hours}` : String(hours);

  return `${month}-${day}-${year}: ${hourStr}:${minutes} ${ampm}`;
}

function loadBook(): TradeRecord[] {
  try {
    ensureDir();
    if (!fs.existsSync(bookPath)) return [];
    const raw = fs.readFileSync(bookPath, 'utf8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data as TradeRecord[];
    return [];
  } catch {
    return [];
  }
}

function saveBook(entries: TradeRecord[]) {
  ensureDir();
  fs.writeFileSync(bookPath, JSON.stringify(entries, null, 2), 'utf8');
}

function numericIdFragment() {
  return Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
}

function deriveId(symbol: string, isoTime: string) {
  const base = isoTime.replace(/[-:TZ]/g, '').slice(0, 14); // YYYYMMDDhhmmss
  return `${symbol}-${base}-${numericIdFragment()}`;
}

export function findOpenTrade(query: { id?: string; symbol: string }): TradeRecord | undefined {
  const entries = loadBook();
  if (query.id) {
    const byId = entries.find((entry) => entry.id === query.id);
    if (byId && byId.status === 'OPEN') return byId;
  }
  return entries.find(
    (entry) => entry.symbol === query.symbol && entry.status === 'OPEN',
  );
}

export function recordTradeOpen(payload: TradeOpenPayload): string {
  const entries = loadBook();
  const entry_time = formatTimestamp(payload.entryTime);
  const id = payload.id ?? deriveId(payload.symbol, entry_time);

  const existingIdx = entries.findIndex((entry) => entry.id === id);

  const record: TradeRecord = {
    id,
    symbol: payload.symbol,
    strategy: payload.strategy,
    side: payload.side,
    entry_time,
    entry_price: Number(payload.entryPrice),
    used_balance: Number(payload.usedBalance),
    wallet_before: Number(payload.walletBefore),
    filters: payload.filters ?? {},
    status: 'OPEN',
  };

  if (typeof payload.qty === 'number') record.qty = Number(payload.qty);
  if (payload.orderId) record.order_id = payload.orderId;
  if (typeof payload.commissionEstimate === 'number') {
    record.commission_estimate = Number(payload.commissionEstimate);
  }

  if (existingIdx >= 0) {
    entries[existingIdx] = { ...entries[existingIdx], ...record };
  } else {
    entries.push(record);
  }
  saveBook(entries);
  return id;
}

export function recordTradeClose(payload: TradeClosePayload): TradeRecord | null {
  const entries = loadBook();
  const idx = entries.findIndex((entry) =>
    payload.id ? entry.id === payload.id : entry.symbol === payload.symbol && entry.status === 'OPEN',
  );

  if (idx === -1) {
    return null;
  }

  const entry = { ...entries[idx] };

  entry.close_time = formatTimestamp(payload.closeTime);
  if (typeof payload.exitPrice === 'number' && Number.isFinite(payload.exitPrice)) {
    entry.exit_price = Number(payload.exitPrice);
  }
  if (typeof payload.walletAfter === 'number' && Number.isFinite(payload.walletAfter)) {
    entry.wallet_after = Number(payload.walletAfter);
  }
  const netProfit =
    typeof entry.wallet_after === 'number' && Number.isFinite(entry.wallet_after)
      ? entry.wallet_after - entry.wallet_before
      : undefined;
  if (typeof netProfit === 'number' && Number.isFinite(netProfit)) {
    entry.net_profit = Number(netProfit.toFixed(6));
    const base = entry.used_balance;
    if (Number.isFinite(base) && base !== 0) {
      entry.roi_pct = Number(((netProfit / base) * 100).toFixed(4));
    }
  }

  if (typeof payload.commissionCost === 'number' && Number.isFinite(payload.commissionCost)) {
    entry.commission_cost = Number(payload.commissionCost.toFixed(6));
  } else if (
    entry.commission_cost === undefined &&
    typeof entry.commission_estimate === 'number' &&
    Number.isFinite(entry.commission_estimate)
  ) {
    entry.commission_cost = Number(entry.commission_estimate.toFixed(6));
  }

  if (payload.closeReason) {
    entry.close_reason = payload.closeReason;
  }

  if (payload.exitQty !== undefined) {
    entry.exit_qty = Number(payload.exitQty);
  }

  if (payload.closeOrderIds && payload.closeOrderIds.length) {
    entry.close_order_ids = payload.closeOrderIds;
  }

  if (payload.realizedPnl !== undefined && Number.isFinite(payload.realizedPnl)) {
    entry.realized_pnl = Number(payload.realizedPnl.toFixed(6));
  }

  if (payload.commissionAsset) {
    entry.commission_asset = payload.commissionAsset;
  }

  // Derive realized_pnl if not provided and we have prices/qty/side
  if (
    entry.realized_pnl === undefined &&
    typeof entry.entry_price === 'number' &&
    typeof entry.exit_price === 'number' &&
    typeof entry.side === 'string'
  ) {
    const qtyUsed =
      typeof entry.exit_qty === 'number' && entry.exit_qty > 0
        ? entry.exit_qty
        : typeof entry.qty === 'number'
          ? entry.qty
          : undefined;
    if (qtyUsed !== undefined && qtyUsed > 0) {
      const direction = entry.side === 'LONG' ? 1 : -1;
      const pnl = (entry.exit_price - entry.entry_price) * qtyUsed * direction;
      entry.realized_pnl = Number(pnl.toFixed(6));
    }
  }

  // If net_profit not derivable from wallet deltas, fall back to realized_pnl
  if (entry.net_profit === undefined && entry.realized_pnl !== undefined) {
    entry.net_profit = Number(entry.realized_pnl.toFixed(6));
    if (Number.isFinite(entry.used_balance) && entry.used_balance !== 0) {
      entry.roi_pct = Number(((entry.net_profit / entry.used_balance) * 100).toFixed(4));
    }
  }

  // Tag outcome for quick win/loss accounting
  if (entry.realized_pnl !== undefined) {
    entry.outcome = entry.realized_pnl > 0 ? 'win' : 'loss';
  } else if (entry.net_profit !== undefined) {
    entry.outcome = entry.net_profit > 0 ? 'win' : 'loss';
  }

  entry.status = payload.status ?? 'CLOSED';

  entries[idx] = entry;
  saveBook(entries);
  return entry;
}

export function loadTradeBook(): TradeRecord[] {
  return loadBook();
}
