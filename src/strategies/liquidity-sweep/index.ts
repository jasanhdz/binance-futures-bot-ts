// Liquidity Sweep + Reclaim (5m)
// - Barre altos/bajos recientes con mecha y volumen
// - Cierra dentro del rango (reclaim)
// - Confirma con la vela siguiente
import { Strategy } from '../types';
import { ema } from '../../core/indicators/ema';
import { last, volumeAvg, bodyPct, wickiness, atrPctNow } from '../../core/utils/candles';

function slope(arr: number[], look = 8) {
  if (arr.length < look + 1) return 0;
  const a = arr[arr.length - 1];
  const b = arr[arr.length - 1 - look];
  return (a - b) / Math.max(1e-9, b);
}

export const LiquiditySweepStrategy: Strategy = {
  name: 'liquidity_sweep',
  timeframe: '5m',

  async evaluate({ symbol, exchange, config, state }) {
    if (state.mode !== 'IDLE') return { action: 'IDLE' };

    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 80) return { action: 'IDLE', reason: 'few_candles' };

    // ——— Contexto: rango (EMA plana + ATR moderado) ———
    const closes = cs.map((c) => c.close);
    const e25Arr = ema(closes, 25);
    const emaFlat =
      Math.abs(slope(e25Arr, config.ROUTER_EMA_SLOPE_LOOKBACK ?? 8)) <=
      (config.ROUTER_EMA_SLOPE_FLAT_MAX ?? 0.0006);

    const atrPct = atrPctNow(cs, config.ATR_PERIOD);
    const atrOk =
      atrPct >= (config.RR_MIN_ATR_PCT ?? 0.001) && atrPct <= (config.RR_MAX_ATR_PCT ?? 0.006);
    if (!(emaFlat && atrOk)) return { action: 'IDLE', reason: 'no_range_context' };

    // ——— Nivel barrido: HH/LL recientes (excluye vela actual) ———
    const look = Number((config as any).SWEEP_LOOKBACK ?? 30);
    const window = cs.slice(-look - 1, -1);
    const HH = Math.max(...window.map((c) => c.high));
    const LL = Math.min(...window.map((c) => c.low));

    const P = cs[cs.length - 2]; // vela del barrido
    const L = last(cs); // vela de confirmación

    const vavg = volumeAvg(cs, Math.max(20, config.VOL_AVG_LEN));
    const needVol = Number((config as any).SWEEP_VOL_FACTOR ?? 1.3) * vavg;

    const minBody = Number((config as any).SWEEP_MIN_BODY_PCT ?? 0.3);
    const maxWick = Number((config as any).SWEEP_MAX_WICKINESS ?? 0.65);

    // ——— SHORT: barre el alto y vuelve al rango (reclaim) ———
    const sweptHigh = P.high > HH && P.close < HH; // mecha arriba y cierra dentro
    const shortConfirm = L.close < Math.min(P.close, HH);
    const shortQual =
      sweptHigh &&
      P.volume >= needVol &&
      wickiness(P) <= maxWick && // evita mecha "exagerada" sin cuerpo
      bodyPct(L) >= minBody;

    if (shortQual && shortConfirm) {
      return { action: 'ENTER_SHORT', reason: 'sweep_reclaim_short' };
    }

    // ——— LONG: barre el bajo y vuelve al rango (reclaim) ———
    const sweptLow = P.low < LL && P.close > LL;
    const longConfirm = L.close > Math.max(P.close, LL);
    const longQual =
      sweptLow && P.volume >= needVol && wickiness(P) <= maxWick && bodyPct(L) >= minBody;

    if (longQual && longConfirm) {
      return { action: 'ENTER_LONG', reason: 'sweep_reclaim_long' };
    }

    return { action: 'IDLE', reason: 'no_sweep' };
  },
};
