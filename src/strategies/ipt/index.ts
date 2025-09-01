// src/strategies/ipt/index.ts
import { Strategy, StrategyContext } from '../types';
import { ema } from '../../core/indicators/ema';
import { Candle } from '../../core/types';
import {
  last,
  bodyPct,
  wickiness,
  volumeAvg,
  nonDecreasing,
  atrPctNow,
  green,
  red,
} from '../../core/utils/candles';

/* ---------- confluencia HTF (EMA 7/25/99) ---------- */
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

/* ---------- Impulse → Pullback → Trigger ---------- */
function impulsePullbackTrigger(candles: Candle[], side: 'LONG' | 'SHORT', cfg: any) {
  const kImp = cfg.IMPULSE_MIN_BARS ?? 2;
  const kPBMin = 1,
    kPBMax = 3;

  const n = candles.length;
  if (n < 60) return { ok: false };

  const vavg = volumeAvg(candles, Math.max(20, cfg.VOL_AVG_LEN));

  // Impulso
  const impulse = candles.slice(-(kImp + kPBMax + 3), -(kPBMax + 1));
  const strong = impulse.filter(
    (c) =>
      bodyPct(c) >= (cfg.MIN_BODY_PCT ?? 0.35) &&
      c.volume >= (cfg.VOL_FACTOR_ENTRY ?? 1.5) * vavg &&
      (side === 'LONG' ? green(c) : red(c)),
  ).length;
  const impulseOK = strong >= kImp;

  // Pullback
  const closes = candles.map((c) => c.close);
  const e25 = last(ema(closes, 25))!;
  const pullback = candles.slice(-(kPBMax + 1), -1);
  const pbLen = Math.min(kPBMax, Math.max(kPBMin, pullback.length));
  const pb = pullback.slice(-pbLen);

  const pbOK =
    pb.length >= kPBMin &&
    pb.every(
      (c) =>
        (side === 'LONG' ? red(c) : green(c)) &&
        (side === 'LONG'
          ? c.close >= e25 * (1 - (cfg.PB_MAX_BREACH_E25 ?? 0.002))
          : c.close <= e25 * (1 + (cfg.PB_MAX_BREACH_E25 ?? 0.002))),
    );

  // Gatillo
  const L = last(candles);
  const hiPB = Math.max(...pb.map((c) => c.high));
  const loPB = Math.min(...pb.map((c) => c.low));
  const breakOK = side === 'LONG' ? L.close > hiPB : L.close < loPB;

  const vols = [...pb.map((c) => c.volume), L.volume];
  const volAsc = nonDecreasing(vols, cfg.VOL_ASC_TOLERANCE ?? 0.02);
  const volStrong = L.volume >= (cfg.VOL_FACTOR_ENTRY ?? 1.5) * vavg;
  const bodyOK = bodyPct(L) >= (cfg.MIN_BODY_PCT ?? 0.35);
  const wicksOK = wickiness(L) <= (cfg.MAX_WICKINESS ?? 0.55);

  const ok = impulseOK && pbOK && breakOK && volAsc && volStrong && bodyOK && wicksOK;

  // ⬅️ devolvemos detalles para las palancas extra
  return { ok, details: { e25, hiPB, loPB, pb, L, vavg } };
}

/* ---------- zona limpia y ATR mínimo ---------- */
function hasCleanZone(candles: Candle[], side: 'LONG' | 'SHORT', cfg: any) {
  const L = last(candles);
  const closes = candles.map((c) => c.close);
  const e99 = last(ema(closes, 99))!;
  const look = cfg.CLEARANCE_LOOKBACK ?? 50;
  const minClr = cfg.MIN_CLEARANCE_PCT ?? 0.004;

  const hi = Math.max(...candles.slice(-look).map((c) => c.high));
  const lo = Math.min(...candles.slice(-look).map((c) => c.low));

  const distToMA99 = Math.abs(L.close - e99) / e99;
  const distToHH = Math.abs(hi - L.close) / L.close;
  const distToLL = Math.abs(L.close - lo) / L.close;

  return side === 'LONG'
    ? distToMA99 >= minClr && distToHH >= minClr
    : distToMA99 >= minClr && distToLL >= minClr;
}

/* ---------- Estrategia IPT (la de tu código anterior) ---------- */
export const IptStrategy: Strategy = {
  name: 'ipt',
  timeframe: '5m',
  async evaluate({ symbol, exchange, config, state, now }: StrategyContext) {
    // Sólo buscamos entradas si estamos IDLE
    if (state.mode !== 'IDLE') return { action: 'IDLE' };

    // Cooldown opcional tras TP (idéntico a tu runner actual)
    const cool = Number((config as any).REENTER_COOLDOWN_MS ?? 5_000);
    if (
      state.lastExitReason === 'tp' &&
      typeof state.lastTPAt === 'number' &&
      now - state.lastTPAt < cool
    ) {
      return { action: 'IDLE', reason: 'tp_cooldown' };
    }

    // Candles del TF de entrada
    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 120) return { action: 'IDLE', reason: 'few_candles' };

    // ATR mínimo (evita rangos muertos)
    const atrOK = atrPctNow(cs, config.ATR_PERIOD) >= config.MIN_ATR_PCT;
    if (!atrOK) return { action: 'IDLE', reason: 'atr_low' };

    // Confluencia multi-TF por EMAs
    const score = await emaTrendScore(symbol, exchange, config); // >0 alcista, <0 bajista
    // LONG
    if (score > 0) {
      const ipt = impulsePullbackTrigger(cs, 'LONG', config);
      if (!ipt.ok) return { action: 'IDLE', reason: 'ipt_fail_long' };

      const { e25, hiPB, loPB, pb, L, vavg } = ipt.details!;
      const filters = await exchange.getSymbolFilters(symbol, config.LEVERAGE);
      const tick = filters.tickSize;
      const prev = cs[cs.length - 2];

      // (1) Límite de extensión vs EMA25 (no comprar demasiado lejos)
      const ext = (L.close - e25) / Math.max(1e-9, e25);
      if (ext > (config.IPT_MAX_EMA25_EXTENSION ?? 0.006)) {
        return { action: 'IDLE', reason: 'ipt_ext_ema25' };
      }

      // (2) Filtro de clímax (cuerpo y volumen desproporcionados)
      const isClimax =
        bodyPct(L) >= (config.CLIMAX_BODY_PCT ?? 0.75) &&
        L.volume >= (config.CLIMAX_VOL_FACTOR ?? 2.2) * vavg;
      if (isClimax) return { action: 'IDLE', reason: 'ipt_climax_filter' };

      // (3) Retest obligatorio del nivel roto (hiPB)
      if (config.IPT_REQUIRE_RETEST) {
        const tol = (config.IPT_RETEST_TICKS ?? 3) * tick;
        const touched = (prev && prev.low <= hiPB + tol) || L.low <= hiPB + tol; // wick que “besa” el nivel
        if (!touched) return { action: 'IDLE', reason: 'ipt_need_retest' };
      }

      // (4) Distancia mínima de stop (lógica del stop “natural” bajo el PB)
      const stopCandidate = Math.min(...pb.map((c) => c.low)) - tick; // 1 tick de colchón
      const dist = L.close - stopCandidate;
      const minDist = Math.max(
        (config.MIN_STOP_DIST_TICKS ?? 4) * tick,
        (config.MIN_STOP_DIST_PCT ?? 0.0015) * L.close,
      );
      if (dist < minDist) return { action: 'IDLE', reason: 'ipt_stop_too_tight' };

      const clean = hasCleanZone(cs, 'LONG', config);
      if (!clean) return { action: 'IDLE', reason: 'no_clearance_long' };
      return { action: 'ENTER_LONG', reason: 'ipt_long' };
    }

    // SHORT
    if (score < 0) {
      const ipt = impulsePullbackTrigger(cs, 'SHORT', config);
      if (!ipt.ok) return { action: 'IDLE', reason: 'ipt_fail_short' };

      const { e25, hiPB, loPB, pb, L, vavg } = ipt.details!;
      const filters = await exchange.getSymbolFilters(symbol, config.LEVERAGE);
      const tick = filters.tickSize;
      const prev = cs[cs.length - 2];

      // (1) Límite de extensión vs EMA25 (no vender demasiado lejos)
      const ext = (e25 - L.close) / Math.max(1e-9, e25);
      if (ext > (config.IPT_MAX_EMA25_EXTENSION ?? 0.006)) {
        return { action: 'IDLE', reason: 'ipt_ext_ema25' };
      }

      // (2) Filtro de clímax
      const isClimax =
        bodyPct(L) >= (config.CLIMAX_BODY_PCT ?? 0.75) &&
        L.volume >= (config.CLIMAX_VOL_FACTOR ?? 2.2) * vavg;
      if (isClimax) return { action: 'IDLE', reason: 'ipt_climax_filter' };

      // (3) Retest obligatorio del nivel roto (loPB)
      if (config.IPT_REQUIRE_RETEST) {
        const tol = (config.IPT_RETEST_TICKS ?? 3) * tick;
        const touched = (prev && prev.high >= loPB - tol) || L.high >= loPB - tol;
        if (!touched) return { action: 'IDLE', reason: 'ipt_need_retest' };
      }

      // (4) Distancia mínima de stop (por encima del PB)
      const stopCandidate = Math.max(...pb.map((c) => c.high)) + tick;
      const dist = stopCandidate - L.close;
      const minDist = Math.max(
        (config.MIN_STOP_DIST_TICKS ?? 4) * tick,
        (config.MIN_STOP_DIST_PCT ?? 0.0015) * L.close,
      );
      if (dist < minDist) return { action: 'IDLE', reason: 'ipt_stop_too_tight' };

      const clean = hasCleanZone(cs, 'SHORT', config);
      if (!clean) return { action: 'IDLE', reason: 'no_clearance_short' };
      return { action: 'ENTER_SHORT', reason: 'ipt_short' };
    }

    return { action: 'IDLE', reason: 'no_confluence' };
  },
};
