import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { computeStopFromLiqTicks, roundToTick } from '../../core/risk/stop';

const THROTTLE_MS = 5_000;
const lastTry: Record<string, number> = {};
const K = (sym: string, side: 'LONG' | 'SHORT') => `${sym}:${side}:arm`;

export async function ensureBracketsGuard(
  symbol: string,
  ex: Exchange,
  st: StateStore,
  log: Logger,
) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice) return;

  const pos = await ex.readActivePosition(symbol, s.lastSide);
  if (!pos) return;

  // 1) Lee órdenes existentes (acepta closePosition o reduceOnly)
  const list: Array<{
    orderId: string;
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    stopPrice: number;
  }> = (await (ex as any).listCloseOrdersForSide?.(symbol, s.lastSide)) ?? [];

  // Dedupe: deja 1 STOP y 1 TP como máximo
  const stops = list.filter((o) => o.type === 'STOP_MARKET');
  const tps = list.filter((o) => o.type === 'TAKE_PROFIT_MARKET');

  if (stops.length > 1) {
    await (ex as any).cancelOrdersByIds?.(
      symbol,
      stops.slice(1).map((o) => o.orderId),
    );
    log.warn('brackets_dedupe_stop', { canceled: stops.length - 1 });
  }
  if (tps.length > 1) {
    await (ex as any).cancelOrdersByIds?.(
      symbol,
      tps.slice(1).map((o) => o.orderId),
    );
    log.warn('brackets_dedupe_tp', { canceled: tps.length - 1 });
  }

  const haveStop = stops.length >= 1;
  const haveTp = tps.length >= 1;

  // 2) Si ya están ambos → marca armado y sal
  if (haveStop && haveTp) {
    if (!s.bracketsArmedAt) st.set({ bracketsArmedAt: Date.now(), posSideMode: pos.sideMode });
    return;
  }

  // 3) Armar sólo si no se ha armado aún EN ESTE RIDE (como hacía tu bot viejo)
  if (s.bracketsArmedAt) return;

  // Throttle para evitar duplicar si openOrders está “lento”
  const k = K(symbol, s.lastSide);
  const now = Date.now();
  if (now - (lastTry[k] ?? 0) < THROTTLE_MS) {
    log.debug('brackets_throttled', { side: s.lastSide });
    return;
  }
  lastTry[k] = now;

  const filters = await ex.getSymbolFilters(symbol, pos.leverage);

  // STOP si falta
  if (!haveStop) {
    const liq = (await ex.readLiquidationPrice(symbol, s.lastSide)) ?? s.lastEntryPrice;
    const ticks = CONFIG.SL_TICKS_ABOVE_LIQ_MAP[symbol] ?? CONFIG.SL_TICKS_ABOVE_LIQ_DEFAULT;
    const mark = await ex.getMarkPrice(symbol);
    const stop = computeStopFromLiqTicks({
      side: s.lastSide,
      liqPrice: liq,
      currentPrice: mark,
      entryPrice: s.lastEntryPrice,
      tickSize: filters.tickSize,
      pricePrecision: filters.pricePrecision,
      ticksAboveLiq: ticks,
    });
    await ex.placeStopClose(symbol, s.lastSide, stop);
    log.info('rearmed_stop', { side: s.lastSide, stop });
  }

  // TP si falta (fijo por ROE desde entry; NO re-upsert en cada tick)
  if (!haveTp) {
    const r = CONFIG.TP_ROE;
    const fee = CONFIG.FEE_BUFFER_PCT;
    const tpRaw =
      s.lastSide === 'LONG'
        ? s.lastEntryPrice * (1 + r / pos.leverage + fee)
        : s.lastEntryPrice * (1 - r / pos.leverage - fee);
    const tp = roundToTick(tpRaw, filters.tickSize, filters.pricePrecision);
    await ex.placeTpClose(symbol, s.lastSide, tp);
    log.info('rearmed_tp', { side: s.lastSide, tp });
  }

  // 4) Marca que ya armamos brackets para este ride
  st.set({ bracketsArmedAt: Date.now(), posSideMode: pos.sideMode });
}
