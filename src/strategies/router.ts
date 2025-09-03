import { Strategy, StrategyContext } from './types';
import { ema } from '../core/indicators/ema';
import { atrPctNow, last } from '../core/utils/candles';
import { IptStrategy } from './ipt';
import { RangeReversionStrategy } from './range-reversion';
import { LiquiditySweepStrategy } from './liquidity-sweep';

export type Profile = 'ipt_sniper' | 'ipt_strict' | 'ipt_relaxed' | 'rr';

async function emaTrendScoreMultiTF(
  symbol: string,
  exchange: StrategyContext['exchange'],
  cfg: any,
): Promise<number> {
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

function emaSlopePct(closes: number[], period: number, lookback: number) {
  if (closes.length < period + lookback + 1) return 0;
  const e = ema(closes, period);
  const a = e[e.length - 1]!;
  const b = e[e.length - 1 - lookback]!;
  return (a - b) / Math.max(1e-9, b);
}

export class RouterStrategy implements Strategy {
  name = 'router';
  timeframe = '5m';

  private lastProfile: Profile = 'ipt_strict';
  private lastSwitchAt = 0;
  private SWITCH_COOLDOWN_MS = 15 * 60_000;

  // Overrides SOLO para la ENTRADA de IPT
  private profiles: Record<Profile, Partial<any>> = {
    ipt_sniper: {
      IPT_REQUIRE_RETEST: 1,
      IPT_MAX_EMA25_EXTENSION: 0.0045,
      MIN_STOP_DIST_TICKS: 5,
      MIN_STOP_DIST_PCT: 0.0018,
      IPT_PB_MAX_VOL_REL: 0.7,
      IPT_PB_MAX_RANGE_REL: 0.85,
      IPT_BREAK_MIN_TICKS: 2,
      IPT_BREAK_MIN_PCT: 0.0003,
      CLEARANCE_LOOKBACK: 80,
      MIN_CLEARANCE_PCT: 0.006,
      VOL_FACTOR_ENTRY: 2.0,
      CLIMAX_BODY_PCT: 0.7,
      CLIMAX_VOL_FACTOR: 2.3,
    },
    ipt_strict: {
      IPT_REQUIRE_RETEST: 1,
      IPT_MAX_EMA25_EXTENSION: 0.006,
      CLIMAX_BODY_PCT: 0.75,
      CLIMAX_VOL_FACTOR: 2.2,
      MIN_STOP_DIST_TICKS: 4,
      MIN_STOP_DIST_PCT: 0.0015,
    },
    ipt_relaxed: {
      IPT_REQUIRE_RETEST: 0,
      IPT_MAX_EMA25_EXTENSION: 0.012,
      CLIMAX_BODY_PCT: 0.75,
      CLIMAX_VOL_FACTOR: 2.2,
      MIN_STOP_DIST_TICKS: 3,
      MIN_STOP_DIST_PCT: 0.001,
    },
    rr: {}, // (se maneja fuera con Sweep/RR)
  };

  private pickProfile = ({
    trendScore,
    emaSlope,
    atrPct,
    cfg,
  }: {
    trendScore: number;
    emaSlope: number;
    atrPct: number;
    cfg: any;
  }): Profile => {
    const STRONG =
      Math.abs(trendScore) >= (cfg.ROUTER_TREND_SCORE_STRONG ?? 2) &&
      Math.abs(emaSlope) >= (cfg.ROUTER_EMA_SLOPE_STRONG ?? 0.001) &&
      atrPct >= (cfg.ROUTER_ATR_MIN_TREND ?? 0.0028);

    const FLAT = Math.abs(emaSlope) <= (cfg.ROUTER_EMA_SLOPE_FLAT_MAX ?? 0.0006);
    const IN_RR =
      atrPct >= (cfg.RR_MIN_ATR_PCT ?? 0.001) && atrPct <= (cfg.RR_MAX_ATR_PCT ?? 0.006);

    if (STRONG) return 'ipt_sniper';
    if (FLAT && IN_RR) return 'rr';
    return 'ipt_strict';
  };

  async evaluate(ctx: StrategyContext) {
    const { symbol, exchange, config } = ctx;

    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 150) return IptStrategy.evaluate(ctx);

    const closes = cs.map((c) => c.close);
    const trendScore = await emaTrendScoreMultiTF(symbol, exchange, config);
    const slope = emaSlopePct(closes, 25, config.ROUTER_EMA_SLOPE_LOOKBACK ?? 8);
    const atrRel = atrPctNow(cs, config.ATR_PERIOD ?? 14);

    // Perfil deseado y cooldown de cambios
    const wanted = this.pickProfile({ trendScore, emaSlope: slope, atrPct: atrRel, cfg: config });
    const now = ctx.now ?? Date.now();
    const cooldown = (config as any).SWITCH_COOLDOWN_MS ?? this.SWITCH_COOLDOWN_MS;
    const profile = now - this.lastSwitchAt < cooldown ? this.lastProfile : wanted;
    if (profile !== this.lastProfile) {
      this.lastProfile = profile;
      this.lastSwitchAt = now;
    }

    // ——— RANGO: intentar Sweep → si no hay, Range-Reversion ———
    if (profile === 'rr') {
      const sweep = await LiquiditySweepStrategy.evaluate(ctx);
      if (sweep.action !== 'IDLE') {
        const reason = [
          sweep.reason,
          'profile:rr',
          `score:${trendScore}`,
          `slope:${slope}`,
          `atr:${atrRel}`,
        ]
          .filter(Boolean)
          .join('|');
        return { ...sweep, reason };
      }
      const rr = await RangeReversionStrategy.evaluate(ctx);
      const reason = [
        rr.reason,
        'profile:rr',
        `score:${trendScore}`,
        `slope:${slope}`,
        `atr:${atrRel}`,
      ]
        .filter(Boolean)
        .join('|');
      return { ...rr, reason };
    }

    // ——— TENDENCIA: usar IPT con overrides del perfil ———
    const merged = { ...config, ...this.profiles[profile] };
    const base = await IptStrategy.evaluate({ ...ctx, config: merged });
    const reason = [
      base.reason,
      `profile:${profile}`,
      `score:${trendScore}`,
      `slope:${slope}`,
      `atr:${atrRel}`,
    ]
      .filter(Boolean)
      .join('|');
    return { ...base, reason };
  }
}
