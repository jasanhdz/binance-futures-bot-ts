// profit-guard.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { finalizeTrade } from '../trade-book-hooks';

export async function enforceProfitGuard(
  symbol: string,
  ex: Exchange,
  st: StateStore,
  log: Logger,
) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice) return;

  const pos = await ex.readActivePosition(symbol, s.lastSide);
  if (!pos) return;

  const mark = await ex.getMarkPrice(symbol);
  const roe =
    (s.lastSide === 'LONG'
      ? (mark - s.lastEntryPrice) / s.lastEntryPrice
      : (s.lastEntryPrice - mark) / s.lastEntryPrice) * pos.leverage;

  const peak = s.peakRoe ?? roe;
  const newPeak = Math.max(peak, roe);
  if (newPeak !== peak) st.set({ peakRoe: newPeak });

  // -------- Time-Stop de oportunidad (si no despega, reciclar margen) --------
  const TIME_STOP_MINUTES = Number((CONFIG as any).TIME_STOP_MINUTES ?? 0);
  const TIME_STOP_MIN_ROE = Number((CONFIG as any).TIME_STOP_MIN_ROE ?? 0);
  const withinTimeStop =
    TIME_STOP_MINUTES > 0 &&
    typeof s.lastEntryAt === 'number' &&
    Date.now() - s.lastEntryAt > TIME_STOP_MINUTES * 60_000;

  if (withinTimeStop && roe < TIME_STOP_MIN_ROE) {
    await ex.closeSideMarketSafe(symbol, s.lastSide, pos.qtyAbs, pos.sideMode);
    await (ex as any).cancelCloseOrdersForSide?.(symbol, s.lastSide);
    const resetPatch = await finalizeTrade({
      symbol,
      exchange: ex,
      state: st,
      logger: log,
      reason: 'time_stop',
      exitPrice: mark,
    });
    st.set({ mode: 'IDLE', lastExitReason: 'time_stop', lastExitAt: Date.now(), ...resetPatch });
    log.info('Time_stop_close', { roe, minRoe: TIME_STOP_MIN_ROE, minutes: TIME_STOP_MINUTES });
    return;
  }

  // -------- Logs de estado --------
  log.debug('profit_guard_status', {
    side: s.lastSide,
    entry: s.lastEntryPrice,
    mark,
    roe,
    peak,
    newPeak,
  });

  // -------- BE lock --------
  if (peak >= CONFIG.PROFIT_LOCK_BE_AT_ROE && roe < CONFIG.PROFIT_LOCK_BE_AT_ROE) {
    await ex.closeSideMarketSafe(symbol, s.lastSide, pos.qtyAbs, pos.sideMode);
    await (ex as any).cancelCloseOrdersForSide?.(symbol, s.lastSide);
    const resetPatch = await finalizeTrade({
      symbol,
      exchange: ex,
      state: st,
      logger: log,
      reason: 'be_protect',
      exitPrice: mark,
    });
    st.set({ mode: 'IDLE', lastExitReason: 'be_protect', lastExitAt: Date.now(), ...resetPatch });
    log.info('BE_protect_close', { roe, threshold: CONFIG.PROFIT_LOCK_BE_AT_ROE });
    return;
  }

  // -------- Giveback tras armarse --------
  if (newPeak >= CONFIG.PROFIT_GIVEBACK_ARM_ROE) {
    const drop = newPeak - roe;
    const rel = newPeak > 0 ? drop / newPeak : 0;
    log.debug('profit_giveback_check', {
      newPeak,
      roe,
      drop,
      rel,
      relReq: CONFIG.PROFIT_GIVEBACK_DROP_REL,
      dropMin: CONFIG.PROFIT_GIVEBACK_DROP_MIN,
    });

    if (rel >= CONFIG.PROFIT_GIVEBACK_DROP_REL && drop >= CONFIG.PROFIT_GIVEBACK_DROP_MIN) {
      await ex.closeSideMarketSafe(symbol, s.lastSide, pos.qtyAbs, pos.sideMode);
      await (ex as any).cancelCloseOrdersForSide?.(symbol, s.lastSide);
      const resetPatch = await finalizeTrade({
        symbol,
        exchange: ex,
        state: st,
        logger: log,
        reason: 'giveback',
        exitPrice: mark,
      });
      st.set({ mode: 'IDLE', lastExitReason: 'giveback', lastExitAt: Date.now(), ...resetPatch });
      log.info('Giveback_close', { newPeak, roe, drop, rel });
    }
  }
}
