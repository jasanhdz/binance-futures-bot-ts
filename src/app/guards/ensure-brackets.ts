// src/app/guards/ensure-brackets.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { roundToTick } from '../../core/risk/stop';
import { Side } from '../../core/types';

export async function bracketsGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice) return;

  const pos = await ex.readActivePosition(symbol, s.lastSide as Side);
  if (!pos || !pos.qtyAbs || pos.qtyAbs <= 0) return;

  const stopOpen = await ex.openStopForSide(symbol, s.lastSide as Side);
  const tpOpen = await (ex as any).openTpForSide?.(symbol, s.lastSide as Side);

  if (stopOpen && tpOpen) return;

  const filters = await ex.getSymbolFilters(symbol, pos.leverage ?? s.lastLeverage!);
  const entry = s.lastEntryPrice!;

  // Emergency Brackets (Fixed %)
  const SL_PCT = 0.02; // 2%
  const TP_PCT = 0.03; // 3%

  if (!stopOpen) {
    const stopRaw = s.lastSide === 'LONG' ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
    const stop = roundToTick(stopRaw, filters.tickSize, filters.pricePrecision);
    await ex.placeStopClose(symbol, s.lastSide as Side, stop);
    log.warn('emergency_stop_created', { side: s.lastSide, stop });
  }

  if (!tpOpen) {
    const tpRaw = s.lastSide === 'LONG' ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
    const tp = roundToTick(tpRaw, filters.tickSize, filters.pricePrecision);
    await ex.placeTpClose(symbol, s.lastSide as Side, tp);
    log.warn('emergency_tp_created', { side: s.lastSide, tp });
  }
}
