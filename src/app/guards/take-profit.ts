// take-profit.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { finalizeTrade } from '../trade-book-hooks';

export async function checkTakeProfit(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice) return;

  const pos = await ex.readActivePosition(symbol, s.lastSide);
  if (!pos) return;

  const mark = await ex.getMarkPrice(symbol);
  const target =
    s.lastSide === 'LONG'
      ? s.lastEntryPrice * (1 + CONFIG.TP_ROE / pos.leverage + CONFIG.FEE_BUFFER_PCT)
      : s.lastEntryPrice * (1 - CONFIG.TP_ROE / pos.leverage - CONFIG.FEE_BUFFER_PCT);
  const hit = s.lastSide === 'LONG' ? mark >= target : mark <= target;

  // Logear aunque no haya disparo
  log.debug('tp_watch', { side: s.lastSide, mark, target, hit });

  if (hit) {
    await ex.closeSideMarketSafe(symbol, s.lastSide, pos.qtyAbs, pos.sideMode);
    await (ex as any).cancelCloseOrdersForSide?.(symbol, s.lastSide);
    const resetPatch = await finalizeTrade({
      symbol,
      exchange: ex,
      state: st,
      logger: log,
      reason: 'take_profit',
      exitPrice: mark,
    });
    st.set({
      lastTPAt: Date.now(),
      lastExitReason: 'tp',
      lastExitAt: Date.now(),
      mode: 'IDLE',
      ...resetPatch,
    });
    log.info('Closed_by_TP', { mark, target });
  }
}
