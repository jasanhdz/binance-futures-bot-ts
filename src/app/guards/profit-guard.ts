import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';

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

  const peak = Math.max(0, s.peakRoe ?? 0);
  const newPeak = Math.max(peak, roe);
  if (newPeak !== peak) st.set({ peakRoe: newPeak });

  log.debug('profit_guard_status', {
    side: s.lastSide,
    entry: s.lastEntryPrice,
    mark,
    roe,
    peak,
    newPeak,
  });

  if (peak >= CONFIG.PROFIT_LOCK_BE_AT_ROE && roe < CONFIG.PROFIT_LOCK_BE_AT_ROE) {
    await ex.closeSideMarketSafe(symbol, s.lastSide, pos.qtyAbs, pos.sideMode);
    await (ex as any).cancelCloseOrdersForSide?.(symbol, s.lastSide);
    st.set({ mode: 'IDLE', lastExitReason: 'be_protect' });
    log.info('BE_protect_close', { roe, threshold: CONFIG.PROFIT_LOCK_BE_AT_ROE });
    return;
  }

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
      st.set({ mode: 'IDLE', lastExitReason: 'giveback' });
      log.info('Giveback_close', { newPeak, roe, drop, rel });
    }
  }
}
