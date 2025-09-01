// Estrategia Range-Reversion (EMA25 ± k·ATR)
import { Strategy, StrategyContext } from '../types';
import { ema } from '../../core/indicators/ema';
import { atr } from '../../core/indicators/atr';
import { last, bodyPct, wickiness, atrPctNow } from '../../core/utils/candles';

function slope(a: number[], n = 5) {
  if (a.length < n + 1) return 0;
  const x = a.slice(-n - 1);
  const y0 = x[0],
    y1 = x[x.length - 1];
  return (y1 - y0) / Math.max(1e-9, n);
}

export const RangeReversionStrategy: Strategy = {
  name: 'range_reversion',
  timeframe: '5m',
  async evaluate({ symbol, exchange, config, state }: StrategyContext) {
    if (state.mode !== 'IDLE') return { action: 'IDLE' };

    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 120) return { action: 'IDLE', reason: 'few_candles' };

    // 1) Mercado adecuado: poca direccionalidad + volatilidad moderada
    const closes = cs.map((c) => c.close);
    const e25Arr = ema(closes, 25);
    const e25 = last(e25Arr)!;
    const a = atr(cs, config.ATR_LEN ?? 14);
    const atrPct = atrPctNow(cs, config.ATR_PERIOD);

    const rrMinAtr = Number((config as any).RR_MIN_ATR_PCT ?? 0.001); // 0.10%
    const rrMaxAtr = Number((config as any).RR_MAX_ATR_PCT ?? 0.006); // 0.60%
    const emaSlopeFlatMax = Number((config as any).RR_MAX_EMA_SLOPE ?? e25 * 0.0006); // ~0.06%

    const emaIsFlat = Math.abs(slope(e25Arr, 8)) <= emaSlopeFlatMax;
    const atrInRange = atrPct >= rrMinAtr && atrPct <= rrMaxAtr;
    if (!emaIsFlat || !atrInRange || !Number.isFinite(a) || a <= 0)
      return { action: 'IDLE', reason: 'no_range_context' };

    // 2) Canal tipo Keltner: centro EMA25, ancho k·ATR
    const k = Number((config as any).RR_BAND_K ?? 1.6);
    const upper = e25 + k * a;
    const lower = e25 - k * a;

    const L = cs[cs.length - 1];
    const prev = cs[cs.length - 2];

    const minBody = Number((config as any).RR_MIN_BODY_PCT ?? 0.3);
    const maxWick = Number((config as any).RR_MAX_WICKINESS ?? 0.6);

    // 3) Señales
    // LONG: cierre vuelve a entrar desde abajo (reingreso), con rechazo y cuerpo decente
    const longReentry =
      prev.close < lower &&
      L.close > lower &&
      L.low < prev.low &&
      bodyPct(L) >= minBody &&
      wickiness(L) <= maxWick;

    // SHORT: reingreso desde arriba
    const shortReentry =
      prev.close > upper &&
      L.close < upper &&
      L.high > prev.high &&
      bodyPct(L) >= minBody &&
      wickiness(L) <= maxWick;

    // Evitar clímax en la vela de señal (no entrar en agotamiento)
    const climaxBody = Number((config as any).CLIMAX_BODY_PCT ?? 0.75);
    const climax = bodyPct(L) >= climaxBody;

    if (climax) return { action: 'IDLE', reason: 'climax_filter' };

    if (longReentry) return { action: 'ENTER_LONG', reason: 'rr_long_reentry' };
    if (shortReentry) return { action: 'ENTER_SHORT', reason: 'rr_short_reentry' };

    return { action: 'IDLE', reason: 'no_setup' };
  },
};
