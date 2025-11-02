import fs from 'fs';
import path from 'path';
import { Exchange, TradeFill } from '../core/ports/Exchange';
import { Logger } from '../core/ports/Logger';
import { StateStore } from '../core/ports/StateStore';
import { findOpenTrade, recordTradeClose, recordTradeOpen } from '../core/analytics/trade_book';
import { tradeStateResetPatch } from './trade-state';
import { BotState, Side } from '../core/types';
import { extractFilters, inferSideFromQty, splitStrategyReason } from './trade-book-utils';
import { recordSymbolOutcome } from './symbol-penalty';

const logsDir = path.resolve(__dirname, '../../logs');
const HISTORY_FILE_RE = /^history-\d{4}-\d{2}-\d{2}\.log$/;
const LOG_SCAN_FILES = 5;

type LogSnapshot = {
  entryTime?: string;
  side?: Side;
  qty?: number;
  entryPrice?: number;
  walletBefore?: number;
  usedBalance?: number;
  commissionEstimate?: number;
  strategy?: string;
  filters?: Record<string, unknown>;
  reasonDetail?: string;
};

function finiteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length) {
    const num = Number(v);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function listRecentLogFiles(): string[] {
  try {
    if (!fs.existsSync(logsDir)) return [];
    return fs
      .readdirSync(logsDir)
      .filter((f) => HISTORY_FILE_RE.test(f))
      .sort()
      .reverse()
      .slice(0, LOG_SCAN_FILES)
      .map((f) => path.join(logsDir, f));
  } catch {
    return [];
  }
}

function tryParseLine(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function summarizeClosingFills(fills: TradeFill[], entrySide?: Side) {
  if (!entrySide || !fills.length) return null;
  const sorted = [...fills].sort((a, b) => a.time - b.time);
  const openSign = entrySide === 'LONG' ? 1 : -1;
  const closingSign = -openSign;
  let position = 0;
  let closingSegment: TradeFill[] = [];
  let latest: TradeFill[] = [];

  for (const fill of sorted) {
    const dir = fill.side === 'BUY' ? 1 : -1;
    const qty = Math.abs(fill.qty);
    const prev = position;
    position += dir * qty;

    const reducing =
      prev !== 0 &&
      Math.sign(prev) === openSign &&
      dir === closingSign &&
      Math.abs(position) <= Math.abs(prev);

    if (reducing) {
      closingSegment.push(fill);
    } else if (dir === openSign) {
      closingSegment = [];
    }

    if (position === 0 && closingSegment.length) {
      latest = closingSegment.slice();
      closingSegment = [];
    }
  }

  if (!latest.length) return null;
  const totalQty = latest.reduce((s, f) => s + Math.abs(f.qty), 0);
  if (totalQty <= 0) return null;
  const weightedPrice = latest.reduce((s, f) => s + Number(f.price) * Math.abs(f.qty), 0);
  const closeTime = Math.max(...latest.map((f) => f.time));
  const orderIds = Array.from(new Set(latest.map((f) => String(f.orderId))));
  const realizedPnl = latest.reduce((s, f) => s + (f.realizedPnl ?? 0), 0);
  const commission = latest.reduce((s, f) => s + (f.commission ?? 0), 0);
  const commissionAsset = latest.find((f) => f.commissionAsset)?.commissionAsset;

  return {
    avgPrice: weightedPrice / totalQty,
    qty: totalQty,
    closeTime,
    orderIds,
    realizedPnl,
    commission,
    commissionAsset,
  };
}

function gatherLogSnapshot(symbol: string): LogSnapshot | null {
  const target = symbol.toUpperCase();
  const files = listRecentLogFiles();
  if (!files.length) return null;

  const snapshot: LogSnapshot & {
    hasMarket?: boolean;
    hasSizing?: boolean;
    hasSignal?: boolean;
  } = {};

  for (const file of files) {
    let data: string;
    try {
      data = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!data) continue;
    const lines = data.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = tryParseLine(lines[i]);
      if (!entry || typeof entry !== 'object') continue;
      const ctx = entry.ctx;
      if (!ctx || typeof ctx.symbol !== 'string' || ctx.symbol.toUpperCase() !== target) continue;

      if (!snapshot.hasMarket && entry.msg === 'market_opened') {
        snapshot.hasMarket = true;
        snapshot.entryTime = entry.ts;
        snapshot.side = typeof ctx.side === 'string' ? (ctx.side as Side) : snapshot.side;
        const avg = finiteNumber(ctx.avgPrice);
        const rawPrice = finiteNumber(ctx.price);
        snapshot.entryPrice = avg ?? rawPrice ?? snapshot.entryPrice;
        const qty = finiteNumber(ctx.qty);
        if (qty !== undefined) snapshot.qty = qty;
      } else if (snapshot.hasMarket && !snapshot.hasSizing && entry.msg === 'sizing_ok') {
        snapshot.hasSizing = true;
        const usdt = finiteNumber(ctx.usdt);
        if (usdt !== undefined) snapshot.walletBefore = usdt;
        const used = finiteNumber(ctx.usedBalance ?? ctx.initMargin);
        if (used !== undefined) snapshot.usedBalance = used;
        const commission = finiteNumber(ctx.commissionEstimate);
        if (commission !== undefined) snapshot.commissionEstimate = commission;
      } else if (snapshot.hasMarket && !snapshot.hasSignal && entry.msg === 'signal') {
        const action = typeof ctx.action === 'string' ? ctx.action : '';
        if (action.startsWith('ENTER')) {
          snapshot.hasSignal = true;
          snapshot.reasonDetail = typeof ctx.reason === 'string' ? ctx.reason : '';
          const { strategy, detail } = splitStrategyReason(snapshot.reasonDetail, 'unknown');
          snapshot.strategy = strategy;
          const parsedFilters = extractFilters(detail);
          const diagnostics =
            ctx.diagnostics && typeof ctx.diagnostics === 'object' ? ctx.diagnostics : undefined;
          const combined: Record<string, unknown> = {};
          if (Object.keys(parsedFilters).length) combined.reason = parsedFilters;
          if (diagnostics && Object.keys(diagnostics).length) combined.diagnostics = diagnostics;
          if (Object.keys(combined).length) {
            snapshot.filters = combined;
          }
        }
      }

      if (snapshot.hasMarket && snapshot.hasSizing && snapshot.hasSignal) {
        break;
      }
    }
    if (snapshot.hasMarket && snapshot.hasSizing && snapshot.hasSignal) {
      break;
    }
  }

  if (!snapshot.hasMarket) {
    return null;
  }
  return {
    entryTime: snapshot.entryTime,
    side: snapshot.side,
    qty: snapshot.qty,
    entryPrice: snapshot.entryPrice,
    walletBefore: snapshot.walletBefore,
    usedBalance: snapshot.usedBalance,
    commissionEstimate: snapshot.commissionEstimate,
    strategy: snapshot.strategy,
    filters: snapshot.filters,
    reasonDetail: snapshot.reasonDetail,
  };
}

type TradeFinalizerParams = {
  symbol: string;
  exchange: Exchange;
  state: StateStore;
  logger: Logger;
  reason: string;
  markPrice?: number;
  exitPrice?: number;
  walletAfter?: number;
  status?: 'CLOSED' | 'CANCELLED';
};

export async function finalizeTrade(params: TradeFinalizerParams): Promise<Partial<BotState>> {
  const { symbol, exchange, state, logger, reason, markPrice, exitPrice, walletAfter, status } =
    params;
  const snapshot = state.get();

  let tradeId = snapshot.lastTradeId;

  if (!tradeId) {
    logger.warn('trade_finalize_missing_id', { symbol, reason });
  }

  let finalPrice = typeof exitPrice === 'number' ? exitPrice : markPrice;
  if (finalPrice === undefined) {
    try {
      finalPrice = await exchange.getMarkPrice(symbol);
    } catch (err: any) {
      logger.warn('trade_finalize_mark_fail', {
        symbol,
        err: err?.message || String(err),
      });
    }
  }

  let finalWallet = walletAfter;
  if (finalWallet === undefined) {
    try {
      finalWallet = await exchange.getUSDTBalance();
    } catch (err: any) {
      logger.warn('trade_finalize_wallet_fail', {
        symbol,
        err: err?.message || String(err),
      });
    }
  }

  let closeSummary: ReturnType<typeof summarizeClosingFills> | null = null;
  if (snapshot.lastSide) {
    try {
      const start = snapshot.lastEntryAt ? snapshot.lastEntryAt - 120_000 : undefined;
      const fills = await exchange.getRecentFills(symbol, start);
      closeSummary = summarizeClosingFills(fills, snapshot.lastSide);
    } catch (err: any) {
      logger.warn('trade_finalize_fills_fail', { symbol, err: err?.message || String(err) });
    }
  }

  const closeTime = closeSummary?.closeTime ?? Date.now();
  const exitPriceUsed = closeSummary?.avgPrice ?? finalPrice;
  const exitQty = closeSummary?.qty;
  const closeOrderIds = closeSummary?.orderIds;
  const realizedPnl = closeSummary?.realizedPnl;
  const commissionCost =
    closeSummary?.commission !== undefined
      ? closeSummary.commission
      : typeof snapshot.lastCommissionEstimate === 'number'
        ? snapshot.lastCommissionEstimate
        : undefined;
  const commissionAsset = closeSummary?.commissionAsset;

  try {
    recordTradeClose({
      id: tradeId,
      symbol,
      closeTime,
      exitPrice: exitPriceUsed,
      walletAfter: finalWallet,
      commissionCost,
      closeReason: reason,
      status,
      exitQty,
      closeOrderIds,
      realizedPnl,
      commissionAsset,
    });
  } catch (err: any) {
    logger.error('trade_book_close_fail', { symbol, reason, err: err?.message || String(err) });
  }

  const entryPrice = snapshot.lastEntryPrice ?? undefined;
  const entryQty = snapshot.lastEntryQty ?? exitQty ?? undefined;
  const side = snapshot.lastSide;
  let pnlUsd =
    typeof realizedPnl === 'number' && Number.isFinite(realizedPnl)
      ? Number(realizedPnl)
      : undefined;
  if (
    pnlUsd === undefined &&
    typeof entryPrice === 'number' &&
    typeof exitPriceUsed === 'number' &&
    typeof entryQty === 'number' &&
    entryQty > 0 &&
    (side === 'LONG' || side === 'SHORT')
  ) {
    const direction = side === 'LONG' ? 1 : -1;
    pnlUsd = Number(((exitPriceUsed - entryPrice) * entryQty * direction).toFixed(6));
  }

  let roiPct: number | undefined;
  if (
    pnlUsd !== undefined &&
    typeof entryPrice === 'number' &&
    typeof entryQty === 'number' &&
    entryQty > 0
  ) {
    const leverageUsed = snapshot.lastLeverage ?? 0;
    const notional = entryPrice * entryQty;
    const margin = leverageUsed > 0 ? notional / Math.max(1, leverageUsed) : notional;
    if (margin > 0) {
      roiPct = Number(((pnlUsd / margin) * 100).toFixed(2));
    }
  }

  if (pnlUsd !== undefined) {
    const outcome = pnlUsd > 0 ? 'win' : 'loss';
    recordSymbolOutcome(symbol, {
      outcome,
      entryTime: snapshot.lastEntryAt,
      exitTime: closeTime,
      entryPrice,
      exitPrice: exitPriceUsed,
      qty: entryQty,
      reason,
      roiPct,
      pnlUsd,
    });
    logger.info(outcome === 'win' ? 'symbol_win_recorded' : 'symbol_loss_recorded', {
      symbol,
      outcome,
      pnlUsd,
      roiPct,
      reason,
    });
  }

  return tradeStateResetPatch();
}

type BackfillParams = {
  symbol: string;
  exchange: Exchange;
  state: StateStore;
  logger: Logger;
};

async function readActivePositionSafe(
  exchange: Exchange,
  symbol: string,
  sideHint?: Side,
): Promise<{ info: Awaited<ReturnType<Exchange['readActivePosition']>> | null; hint?: Side }> {
  const hints: Side[] = sideHint ? [sideHint] : ['LONG', 'SHORT'];
  for (const hint of hints) {
    try {
      const info = await exchange.readActivePosition(symbol, hint);
      if (info) return { info, hint };
    } catch {}
  }
  return { info: null, hint: sideHint };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export async function ensureOpenTradeBackfill(params: BackfillParams): Promise<void> {
  const { symbol, exchange, state, logger } = params;

  const snapshot = state.get();
  if (snapshot.mode === 'IDLE') return;

  let existing = findOpenTrade({ id: snapshot.lastTradeId, symbol });
  if (!existing) {
    existing = findOpenTrade({ symbol });
  }
  if (existing) {
    if (!snapshot.lastTradeId || snapshot.lastTradeId !== existing.id) {
      state.set({
        lastTradeId: existing.id,
        lastStrategyName: snapshot.lastStrategyName ?? existing.strategy,
        lastEntryWallet: snapshot.lastEntryWallet ?? existing.wallet_before,
        lastEntryUsedBalance: snapshot.lastEntryUsedBalance ?? existing.used_balance,
        lastEntryFilters: snapshot.lastEntryFilters ?? existing.filters,
        lastCommissionEstimate: snapshot.lastCommissionEstimate ?? existing.commission_estimate,
      });
    }
    return;
  }

  const logSnapshot = gatherLogSnapshot(symbol);
  const positionData = await readActivePositionSafe(exchange, symbol, snapshot.lastSide);
  const position = positionData.info;
  const sideCandidates: Array<Side | undefined> = [
    snapshot.lastSide,
    logSnapshot?.side,
    positionData.hint,
  ];

  const resolvedSide =
    sideCandidates.find((s): s is Side => s === 'LONG' || s === 'SHORT') ??
    inferSideFromQty(logSnapshot?.qty);

  const qty =
    snapshot.lastEntryQty ??
    (isFiniteNumber(logSnapshot?.qty) ? logSnapshot!.qty : undefined) ??
    position?.qtyAbs;

  const entryPrice =
    snapshot.lastEntryPrice ??
    (isFiniteNumber(logSnapshot?.entryPrice) ? logSnapshot!.entryPrice : undefined) ??
    (position ? position.entryPrice : undefined);

  let leverage =
    snapshot.lastLeverage ??
    (position ? position.leverage : undefined);

  let usedBalance =
    snapshot.lastEntryUsedBalance ??
    (isFiniteNumber(logSnapshot?.usedBalance) ? logSnapshot!.usedBalance : undefined);

  if (!isFiniteNumber(usedBalance) && isFiniteNumber(entryPrice) && isFiniteNumber(qty) && leverage) {
    usedBalance = (qty * entryPrice) / Math.max(1, leverage);
  }

  let walletBefore =
    snapshot.lastEntryWallet ??
    (isFiniteNumber(logSnapshot?.walletBefore) ? logSnapshot!.walletBefore : undefined);

  if (!isFiniteNumber(walletBefore) && isFiniteNumber(usedBalance)) {
    try {
      const balanceNow = await exchange.getUSDTBalance();
      if (Number.isFinite(balanceNow)) {
        walletBefore = balanceNow + usedBalance;
      }
    } catch (err: any) {
      logger.warn('trade_backfill_wallet_snapshot_fail', {
        symbol,
        err: err?.message || String(err),
      });
    }
  }

  const commissionEstimate =
    snapshot.lastCommissionEstimate ??
    (isFiniteNumber(logSnapshot?.commissionEstimate) ? logSnapshot!.commissionEstimate : undefined);

  const strategyName =
    snapshot.lastStrategyName ??
    logSnapshot?.strategy ??
    'unknown';

  const filters =
    snapshot.lastEntryFilters ??
    logSnapshot?.filters ??
    {};

  const entryTime =
    snapshot.lastEntryAt ??
    (logSnapshot?.entryTime ? Date.parse(logSnapshot.entryTime) : undefined) ??
    Date.now();

  if (!isFiniteNumber(entryPrice) || !isFiniteNumber(qty) || qty === 0) {
    logger.warn('trade_backfill_insufficient_data', {
      symbol,
      entryPrice,
      qty,
    });
    return;
  }

  const safeUsedBalance = isFiniteNumber(usedBalance)
    ? usedBalance
    : (entryPrice * qty) / Math.max(1, leverage ?? 1);
  const safeWalletBefore = isFiniteNumber(walletBefore) ? walletBefore : safeUsedBalance;

  let orderId = snapshot.lastOrderId;

  try {
    const tradeId = recordTradeOpen({
      symbol,
      strategy: strategyName,
      side: resolvedSide,
      entryTime,
      entryPrice,
      usedBalance: safeUsedBalance,
      walletBefore: safeWalletBefore,
      filters,
      qty,
      orderId,
      commissionEstimate: commissionEstimate,
    });

    const patch: Partial<BotState> = {
      lastTradeId: tradeId,
      lastStrategyName: strategyName,
      lastEntryWallet: isFiniteNumber(walletBefore) ? walletBefore : safeWalletBefore,
      lastEntryUsedBalance: safeUsedBalance,
      lastEntryFilters: filters,
      lastCommissionEstimate: commissionEstimate,
      lastOrderId: orderId,
    };
    if (!snapshot.lastEntryAt) {
      patch.lastEntryAt = entryTime;
    }
    if (!snapshot.lastEntryQty && isFiniteNumber(qty)) {
      patch.lastEntryQty = qty;
    }
    if (!snapshot.lastEntryPrice && isFiniteNumber(entryPrice)) {
      patch.lastEntryPrice = entryPrice;
    }
    if (!snapshot.lastLeverage && isFiniteNumber(leverage)) {
      patch.lastLeverage = leverage;
    }
    if (!snapshot.lastSide && resolvedSide) {
      patch.lastSide = resolvedSide;
    }
    state.set(patch);
    logger.info('trade_backfill_created', {
      symbol,
      tradeId,
      source: logSnapshot ? 'logs' : 'state',
    });
  } catch (err: any) {
    logger.error('trade_backfill_fail', { symbol, err: err?.message || String(err) });
  }
}
