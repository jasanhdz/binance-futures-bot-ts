import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';

type Candle = {
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
};

function bodyPct(c: Candle) {
  const r = Math.max(1e-9, c.high - c.low);
  return Math.abs(c.close - c.open) / r;
}
function isGreen(c: Candle) {
  return c.close > c.open;
}
function isRed(c: Candle) {
  return c.close < c.open;
}

function avg(a: number[]) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

/**
 * Cierra la posición si:
 * - Estamos dentro de EARLY_FAIL_WINDOW_MS desde la entrada, y
 * - La última vela es fuerte en contra con volumen >= EARLY_FAIL_VOL_FACTOR * vavg.
 */
export async function earlyFailGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryAt) return;

  const EARLY_FAIL_WINDOW_MS = (CONFIG as any).EARLY_FAIL_WINDOW_MS ?? 12 * 60_000;
  const EARLY_FAIL_VOL_FACTOR = (CONFIG as any).EARLY_FAIL_VOL_FACTOR ?? 1.5;
  const SHARP_BODY_PCT = (CONFIG as any).SHARP_BODY_PCT ?? 0.6;

  const withinEarly = Date.now() - s.lastEntryAt <= EARLY_FAIL_WINDOW_MS;
  if (!withinEarly) return;

  const candles = await ex.getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 200);
  if (candles.length < 50) return;

  const last = candles[candles.length - 1];
  const vavg = avg(candles.slice(-Math.max(20, CONFIG.VOL_AVG_LEN) - 1, -1).map((c) => c.volume));
  const strong = bodyPct(last) >= SHARP_BODY_PCT && last.volume >= EARLY_FAIL_VOL_FACTOR * vavg;
  const against = s.lastSide === 'LONG' ? isRed(last) && strong : isGreen(last) && strong;

  log.debug('early_fail_status', {
    side: s.lastSide,
    bodyPct: bodyPct(last),
    lastVol: last.volume,
    vavg,
    strong,
    against,
  });

  if (!against) return;

  const pos = await ex.readActivePosition(symbol, s.lastSide);
  if (!pos) return;
  await ex.closeSideMarketSafe(symbol, s.lastSide, pos.qtyAbs, pos.sideMode);
  await (ex as any).cancelCloseOrdersForSide?.(symbol, s.lastSide);
  st.set({ mode: 'IDLE', lastExitReason: 'early_fail' });
  log.info('Early_fail_close');
}
