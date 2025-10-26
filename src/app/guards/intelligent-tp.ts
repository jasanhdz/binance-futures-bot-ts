import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { finalizeTrade } from '../trade-book-hooks';
import { ema } from '../../core/indicators/ema';
import { adx as adxCalc } from '../../core/indicators/adx';
import { computeFeatures } from '../../core/utils/features';

function computeRoe(opts: {
  side: 'LONG' | 'SHORT';
  entry: number;
  mark: number;
  qty: number;
  leverage: number;
}): number {
  const { side, entry, mark, qty, leverage } = opts;
  if (!entry || !qty || !leverage) return 0;
  const direction = side === 'LONG' ? 1 : -1;
  const pnl = (mark - entry) * qty * direction;
  const notional = mark * qty;
  const margin = notional / Math.max(1, leverage);
  return margin ? pnl / margin : 0;
}

export async function intelligentTakeProfit(
  symbol: string,
  ex: Exchange,
  st: StateStore,
  log: Logger,
) {
  const state = st.get();
  if (state.mode === 'IDLE' || !state.lastSide || !state.lastEntryPrice) return;

  const pos = await ex.readActivePosition(symbol, state.lastSide);
  if (!pos || !pos.qtyAbs) return;

  const mark = await ex.getMarkPrice(symbol);
  const leverage = pos.leverage ?? state.lastLeverage ?? CONFIG.LEVERAGE;
  const roe = computeRoe({
    side: state.lastSide,
    entry: state.lastEntryPrice,
    mark,
    qty: pos.qtyAbs,
    leverage: Math.max(leverage, 1),
  });

  const peak = state.peakRoe ?? roe;
  const newPeak = Math.max(peak, roe);
  if (newPeak !== peak) {
    st.set({ peakRoe: newPeak });
  }

  const minRoe = Number(CONFIG.INT_TP_MIN_ROE ?? 0.2);
  if (roe < minRoe) {
    return; // aún no cubre comisiones, dejar correr
  }

  const now = Date.now();
  const cooldown = Number(CONFIG.INT_TP_COOLDOWN_MS ?? 15_000);
  if (state.lastIntelliTpAt && now - state.lastIntelliTpAt < cooldown) {
    return;
  }

  const lookback = Math.max(40, Number(CONFIG.INT_TP_LOOKBACK ?? 40));
  const tf = CONFIG.ENTRY_TIMEFRAME;
  const candles = await ex.getCandles(symbol, tf, Math.max(lookback * 2, 160));
  if (candles.length < lookback) {
    return;
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const emaFast = ema(closes, 13);
  const emaSlow = ema(closes, 34);
  const fast = emaFast[emaFast.length - 1];
  const slow = emaSlow[emaSlow.length - 1];
  const { adx } = adxCalc(highs, lows, closes, 14);
  const features = computeFeatures(candles);
  const rsi = features.rsi;
  const lastClose = closes[closes.length - 1];

  const adxMin = Number(CONFIG.INT_TP_TREND_ADX ?? 18);
  const trailDrop = Math.max(0, Math.min(1, Number(CONFIG.INT_TP_TRAIL_DROP ?? 0.35)));
  const drop = newPeak > 0 ? Math.max(0, (newPeak - roe) / Math.max(newPeak, 1e-9)) : 0;

  const trendStrongLong = fast > slow && adx >= adxMin && rsi >= 45 && lastClose >= slow;
  const trendStrongShort = fast < slow && adx >= adxMin && rsi <= 55 && lastClose <= slow;

  const shouldRide =
    (state.lastSide === 'LONG' ? trendStrongLong : trendStrongShort) && drop < trailDrop;

  const rideUpdate = shouldRide ? { lastIntelliTpAt: now, intelliTpState: 'ride' as const } : {};
  if (shouldRide) {
    if (newPeak !== peak) {
      st.set({ peakRoe: newPeak, ...rideUpdate });
    } else if (rideUpdate.lastIntelliTpAt) {
      st.set(rideUpdate);
    }
    log.debug('tp_dynamic_hold', {
      symbol,
      roe,
      peak: newPeak,
      drop,
      trendStrong: shouldRide,
      rsi,
      adx,
    });
    return;
  }

  if (roe >= minRoe) {
    await ex.closeSideMarketSafe(symbol, state.lastSide, pos.qtyAbs, pos.sideMode);
    await (ex as any).cancelCloseOrdersForSide?.(symbol, state.lastSide);
    const resetPatch = await finalizeTrade({
      symbol,
      exchange: ex,
      state: st,
      logger: log,
      reason: 'tp_dynamic',
      exitPrice: mark,
    });
    st.set({
      mode: 'IDLE',
      lastExitReason: 'tp_dynamic',
      lastExitAt: now,
      lastIntelliTpAt: now,
      intelliTpState: 'exit',
      ...resetPatch,
    });
    log.info('tp_dynamic_close', {
      symbol,
      roe,
      peak: newPeak,
      drop,
      rsi,
      adx,
    });
  }
}
