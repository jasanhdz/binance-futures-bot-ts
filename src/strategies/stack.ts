// src/strategies/stack_pro.ts
import { Strategy, StrategyContext } from './types';
import { last, volumeAvg, countStreak } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';
import { adx as adxCalc, sma } from '../core/indicators/adx'; // ya tienes sma ahí

import { computeFeatures } from '../ml/features';
import { predictLong, predictShort } from '../ml/adapter';

// Helper local: desviación estándar simple de últimos N cierres
function std(arr: number[], n: number) {
  const k = Math.min(arr.length, n);
  if (k <= 1) return 0;
  const slice = arr.slice(-k);
  const mean = slice.reduce((s, v) => s + v, 0) / k;
  const v = slice.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (k - 1);
  return Math.sqrt(Math.max(0, v));
}

export const StackStrategy: Strategy = {
  name: 'stack_pro',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config, state, now } = ctx;

    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 50) return { action: 'IDLE', reason: 'few_candles' };

    const L = last(cs);

    // ---------- Volumen y rachas ----------
    const vavg = volumeAvg(cs, Math.max(20, config.VOL_AVG_LEN));
    const vOk = L.volume >= config.VOL_FACTOR_ENTRY * vavg;
    const gStreak = countStreak(cs, 'green');
    const rStreak = countStreak(cs, 'red');

    // ---------- Extensión vs EMA ----------
    let extOk = true;
    if (typeof config.ENTRY_MAX_EMA_EXTENSION === 'number') {
      const closesX = cs.map((c) => c.close);
      const e = ema(closesX, config.ENTRY_EMA_PERIOD ?? 20);
      const emaNowX = e[e.length - 1];
      const ext = Math.abs(L.close - emaNowX) / Math.max(1e-9, emaNowX);
      extOk = ext <= (config.ENTRY_MAX_EMA_EXTENSION ?? 1); // si pones 9 = “apagado”
    }

    // ---------- Tendencia por MAs (EMA25 vs EMA99) ----------
    const closes = cs.map((c) => c.close);
    const ema25 = ema(closes, 25);
    const ema99 = ema(closes, 99);
    const bullMA = ema25[ema25.length - 1] > ema99[ema99.length - 1];
    const bearMA = ema25[ema25.length - 1] < ema99[ema99.length - 1];

    // ---------- ADX / DIs ----------
    const highs = cs.map((c) => c.high);
    const lows = cs.map((c) => c.low);
    const { adx, plusDI, minusDI } = adxCalc(highs, lows, closes, 14);
    const adxNow = Number.isFinite(adx) ? (adx as number) : NaN;

    // ---------- Bollinger (anti-entrada en extremos) ----------
    const bbLen = 20;
    const bbK = 2;
    const ma20 = sma(closes, bbLen);
    const sd20 = std(closes, bbLen);
    const upper = Number.isFinite(ma20) && Number.isFinite(sd20) ? ma20 + bbK * sd20 : NaN;
    const lower = Number.isFinite(ma20) && Number.isFinite(sd20) ? ma20 - bbK * sd20 : NaN;
    // Evitar LONG si está por encima de la banda superior; evitar SHORT si está por debajo de la inferior
    const bandOkLong = !Number.isFinite(upper) ? true : L.close <= (upper as number) * 0.999; // margen 0.1%
    const bandOkShort = !Number.isFinite(lower) ? true : L.close >= (lower as number) * 1.001;
    // Para logging neutro:
    const bandOk = bandOkLong && bandOkShort;

    // ---------- ML ----------
    const feats = computeFeatures(cs);
    const pL = predictLong(feats);
    const pS = predictShort(feats);
    const longML = pL >= (config.ML_THRESHOLD_LONG ?? config.ML_THRESHOLD ?? 0.6);
    const shortML = pS >= (config.ML_THRESHOLD_SHORT ?? config.ML_THRESHOLD ?? 0.8);

    // ---------- GATE SHORT (tendencia bajista + ADX + DI) ----------
    const shortTrendOk =
      adxNow >= (config.ADX_MIN_FOR_SHORT ?? 25) &&
      (minusDI ?? 0) > (plusDI ?? 0) &&
      (!(config as any).REQUIRE_BEAR_MA_FOR_SHORT || bearMA);

    // ---------- Señales finales (asimétricas) ----------
    const longOk =
      (config as any).ALLOW_LONGS &&
      vOk &&
      extOk &&
      longML &&
      bullMA &&
      bandOkLong &&
      gStreak >= (config.GREEN_STREAK_MIN ?? 3);

    const shortOk =
      (config as any).ALLOW_SHORTS &&
      vOk &&
      extOk &&
      shortML &&
      shortTrendOk &&
      bandOkShort &&
      rStreak >= (config.RED_STREAK_MIN ?? 3);

    const distTopPct = (upper - L.close) / upper;
    // console.log('band_status', {
    //   distTopPct: (upper - L.close) / upper,
    //   upper,
    //   lower,
    //   close: L.close,
    // });

    // ---- Breakout permission (muy estricto para 100x)
    const BREAK_NEAR = Number(process.env.BAND_BREAK_NEAR ?? 0.0015); // 0.15%
    const NEED_ADX = Number(process.env.BAND_BREAK_MIN_ADX ?? 35);
    const NEED_PL = Number(process.env.BAND_BREAK_MIN_PL ?? 0.65);

    // distTopPct lo traes de tu cálculo de bandas
    const nearTop = distTopPct <= BREAK_NEAR;
    const breakoutLong =
      bullMA && nearTop && adxNow >= NEED_ADX && vOk && pL >= NEED_PL && L.close > upper; // confirmación de ruptura

    if (breakoutLong) {
      return {
        action: 'ENTER_LONG',
        reason: `breakout_long d=${distTopPct.toFixed(4)} adx=${adxNow.toFixed(1)} pL=${pL.toFixed(2)}`,
      };
    }

    // ---------- Re-entrada tras TP (respeta filtros) ----------
    if (
      config.REENTER_ON_TP &&
      state.mode === 'IDLE' &&
      state.lastExitReason === 'tp' &&
      typeof state.lastTPAt === 'number'
    ) {
      const since = now - state.lastTPAt;
      const cool = Number(config.REENTER_COOLDOWN_MS ?? 5000);
      if (since < cool) {
        return { action: 'IDLE', reason: `cooldown ${Math.round((cool - since) / 1000)}s` };
      }

      if (longOk && !shortOk)
        return { action: 'ENTER_LONG', reason: `reenter_long pL=${pL.toFixed(2)}` };
      if (shortOk && !longOk)
        return { action: 'ENTER_SHORT', reason: `reenter_short pS=${pS.toFixed(2)}` };
      return { action: 'IDLE', reason: 'reenter_filters_blocked' };
    }

    // ---------- Resolución: si ambos true, abstener (100x = prudencia) ----------
    if (longOk && shortOk) return { action: 'IDLE', reason: 'conflict_both_valid' };

    if (longOk)
      return {
        action: 'ENTER_LONG',
        reason: `stackPRO_long pL=${pL.toFixed(2)} adx=${Number.isFinite(adxNow) ? adxNow.toFixed(1) : 'NaN'}`,
      };

    if (shortOk)
      return {
        action: 'ENTER_SHORT',
        reason: `stackPRO_short pS=${pS.toFixed(2)} adx=${Number.isFinite(adxNow) ? adxNow.toFixed(1) : 'NaN'}`,
      };

    // ---------- Sin entrada ----------
    return {
      action: 'IDLE',
      reason: `no_entry bull=${bullMA} bear=${bearMA} adx=${Number.isFinite(adxNow) ? adxNow.toFixed(1) : 'NaN'} vOk=${vOk} extOk=${extOk} bandOk=${bandOk} pL=${pL.toFixed(2)} pS=${pS.toFixed(2)}`,
    };
  },
};
