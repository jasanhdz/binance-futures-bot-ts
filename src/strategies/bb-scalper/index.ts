// Bollinger Re-entry Scalper (5m)
import { Strategy } from '../types';
import { ema } from '../../core/indicators/ema';
import { last, avg, bodyPct, wickiness, volumeAvg, atrPctNow } from '../../core/utils/candles';

export const BbScalperStrategy: Strategy = {
  name: 'bb_scalper',
  timeframe: '5m',
  async evaluate({ symbol, exchange, config, state }) {
    if (state.mode !== 'IDLE') return { action: 'IDLE' };

    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 60) return { action: 'IDLE', reason: 'few_candles' };

    // --- Contexto: lateral y volatilidad moderada ---
    const closes = cs.map((c) => c.close);
    const e25 = ema(closes, 25);
    const look = Number((config as any).ROUTER_EMA_SLOPE_LOOKBACK ?? 8);
    const a = e25[e25.length - 1],
      b = e25[Math.max(0, e25.length - 1 - look)];
    const slopePct = Math.abs((a - b) / Math.max(1e-9, b));
    const emaFlat = slopePct <= Number((config as any).ROUTER_EMA_SLOPE_FLAT_MAX ?? 0.0006);

    const atrPct = atrPctNow(cs, config.ATR_PERIOD);
    const atrOk =
      atrPct >= Number((config as any).RR_MIN_ATR_PCT ?? 0.0008) &&
      atrPct <= Number((config as any).RR_MAX_ATR_PCT ?? 0.006);
    if (!(emaFlat && atrOk)) return { action: 'IDLE', reason: 'bb_no_range_context' };

    // --- Bandas de Bollinger (SMA n + k*desv) ---
    const n = Number((config as any).BB_PERIOD ?? 20);
    const k = Number((config as any).BB_K ?? 2.0);
    const win = closes.slice(-n);
    const basis = avg(win);
    const dev = Math.sqrt(avg(win.map((x) => (x - basis) ** 2)));
    const upper = basis + k * dev;
    const lower = basis - k * dev;

    // --- Señales por reingreso a las bandas ---
    const L = last(cs);
    const P = cs[cs.length - 2];

    const vavg = volumeAvg(cs, Math.max(20, config.VOL_AVG_LEN));
    const volOK = L.volume >= Number((config as any).SCALP_VOL_MIN_FACTOR ?? 0.9) * vavg;

    const climax =
      bodyPct(L) >= (config.CLIMAX_BODY_PCT ?? 0.75) &&
      L.volume >= (config.CLIMAX_VOL_FACTOR ?? 2.2) * vavg;
    if (!volOK || climax) {
      return { action: 'IDLE', reason: !volOK ? 'low_vol' : 'climax_filter' };
    }

    const minBody = Number((config as any).RR_MIN_BODY_PCT ?? 0.25);
    const maxWick = Number((config as any).RR_MAX_WICKINESS ?? 0.7);

    const longReentry =
      P.close < lower && L.close > lower && bodyPct(L) >= minBody && wickiness(L) <= maxWick;
    const shortReentry =
      P.close > upper && L.close < upper && bodyPct(L) >= minBody && wickiness(L) <= maxWick;

    if (longReentry) return { action: 'ENTER_LONG', reason: 'bb_long_reentry' };
    if (shortReentry) return { action: 'ENTER_SHORT', reason: 'bb_short_reentry' };
    return { action: 'IDLE', reason: 'bb_no_setup' };
  },
};
