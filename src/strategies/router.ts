// Router: decide el régimen y delega en IPT o Range-Reversion
import { Strategy, StrategyContext } from './types';
import { ema } from '../core/indicators/ema';
import { atrPctNow, last } from '../core/utils/candles';

async function emaTrendScore(symbol: string, exchange: StrategyContext['exchange'], cfg: any) {
  const tfs: string[] = [cfg.ENTRY_TIMEFRAME, ...(cfg.HTF_TFS || [])];
  let score = 0;
  for (const tf of tfs) {
    const cs = await exchange.getCandles(symbol, tf, 200);
    if (cs.length < 120) continue;
    const closes = cs.map((c) => c.close);
    const e7 = last(ema(closes, 7))!;
    const e25 = last(ema(closes, 25))!;
    const e99 = last(ema(closes, 99))!;
    const L = last(cs);
    const longOK = L.close > e25 && e7 > e25 && e25 > e99;
    const shortOK = L.close < e25 && e7 < e25 && e25 < e99;
    if (longOK) score++;
    if (shortOK) score--;
  }
  return score; // >0 alcista, <0 bajista
}

function ema25SlopePct(closes: number[], lookback = 8) {
  const e25 = ema(closes, 25);
  if (e25.length < lookback + 1) return 0;
  const a = e25[e25.length - 1];
  const b = e25[e25.length - 1 - lookback];
  return Math.abs((a - b) / Math.max(1e-9, b)); // % en 'lookback' velas
}

export function makeStrategyRouter(ipt: Strategy, rr: Strategy): Strategy {
  return {
    name: 'router',
    timeframe: ipt.timeframe, // 5m en tu caso
    async evaluate(ctx: StrategyContext) {
      const { symbol, exchange, config, state } = ctx;
      if (state.mode !== 'IDLE') return { action: 'IDLE' };

      // --- Lecturas ligeras del TF de entrada ---
      const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 220);
      if (cs.length < 120) return { action: 'IDLE', reason: 'router_few_candles' };

      const closes = cs.map((c) => c.close);
      const atrPct = atrPctNow(cs, config.ATR_PERIOD);
      const slopePct = ema25SlopePct(
        closes,
        Number((config as any).ROUTER_EMA_SLOPE_LOOKBACK ?? 8),
      );
      const tScore = await emaTrendScore(symbol, exchange, config);

      // --- Umbrales de régimen (configurables) ---
      const TREND_STRONG = Number((config as any).ROUTER_TREND_SCORE_STRONG ?? 2);
      const TREND_WEAK = Number((config as any).ROUTER_TREND_SCORE_WEAK ?? 1);
      const ATR_MIN_TREND = Number((config as any).ROUTER_ATR_MIN_TREND ?? config.MIN_ATR_PCT);
      const RR_MIN_ATR = Number((config as any).RR_MIN_ATR_PCT ?? 0.001);
      const RR_MAX_ATR = Number((config as any).RR_MAX_ATR_PCT ?? 0.006);
      const EMA_SLOPE_FLAT_MAX = Number((config as any).ROUTER_EMA_SLOPE_FLAT_MAX ?? 0.0006); // 0.06%

      // --- Decisión de régimen ---
      const trending = Math.abs(tScore) >= TREND_STRONG && atrPct >= ATR_MIN_TREND;
      const ranging =
        Math.abs(tScore) <= TREND_WEAK &&
        slopePct <= EMA_SLOPE_FLAT_MAX &&
        atrPct >= RR_MIN_ATR &&
        atrPct <= RR_MAX_ATR;

      if (trending) {
        // Delegar en IPT (rupturas con confluencia)
        const res = await ipt.evaluate(ctx);
        return res.action === 'IDLE'
          ? { action: 'IDLE', reason: `router_trend_idle:${res.reason}` }
          : res;
      }

      if (ranging) {
        // Delegar en Range-Reversion (rebotes a la media)
        const res = await rr.evaluate(ctx);
        return res.action === 'IDLE'
          ? { action: 'IDLE', reason: `router_range_idle:${res.reason}` }
          : res;
      }

      // Zona gris: sin señal clara → mejor no forzar
      return {
        action: 'IDLE',
        reason: `router_no_regime:tScore=${tScore},atrPct=${atrPct.toFixed(4)},slope=${slopePct.toFixed(4)}`,
      };
    },
  };
}
