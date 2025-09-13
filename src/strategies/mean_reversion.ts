// src/strategies/mean_reversion.ts
import { Strategy, StrategyContext } from './types';
import { last, volumeAvg, countStreak } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';
import { adx as adxCalc, sma } from '../core/indicators/adx';
import { computeFeatures } from '../ml/features';

function stdev(arr: number[], n = 20) {
  const k = Math.min(arr.length, n);
  if (k <= 1) return NaN;
  const s = arr.slice(-k);
  const m = s.reduce((a, b) => a + b, 0) / k;
  const v = s.reduce((a, b) => a + (b - m) * (b - m), 0) / (k - 1);
  return Math.sqrt(Math.max(0, v));
}

async function confirmBearOn1h(exchange: any, symbol: string, adxMin: number) {
  const c1h = await exchange.getCandles(symbol, '1h', 200);
  if (c1h.length < 30) return false;
  const closes = c1h.map((c: any) => c.close);
  const highs = c1h.map((c: any) => c.high);
  const lows = c1h.map((c: any) => c.low);
  const ema25_1h = ema(closes, 25).pop()!;
  const ema99_1h = ema(closes, 99).pop()!;
  const { adx } = adxCalc(highs, lows, closes, 14);
  const a = Number.isFinite(adx) ? (adx as number) : 0;
  return ema25_1h < ema99_1h && a >= adxMin;
}

export const MeanReversion: Strategy = {
  name: 'mean_reversion',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config } = ctx;

    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 60) return { action: 'IDLE', reason: 'few_candles' };

    const L = last(cs);
    const closes = cs.map((c) => c.close);
    const highs = cs.map((c) => c.high);
    const lows = cs.map((c) => c.low);

    // ===== Régimen: queremos RANGO =====
    const { adx } = adxCalc(highs, lows, closes, 14);
    const adxNow = Number.isFinite(adx) ? (adx as number) : 0;

    const ma20 = sma(closes, 20);
    const sd20 = stdev(closes, 20);
    const upper = ma20 + 2 * sd20;
    const lower = ma20 - 2 * sd20;
    const bandwidth = Number.isFinite(ma20) && ma20 > 0 ? (upper - lower) / ma20 : NaN;

    const isRange =
      adxNow <= (config.MR_ADX_MAX ?? 20) &&
      Number.isFinite(bandwidth) &&
      bandwidth <= (config.MR_BB_WIDTH_MAX ?? 0.025);

    if (!isRange) {
      return {
        action: 'IDLE',
        reason: `no_range adx=${adxNow.toFixed(1)} bw=${Number.isFinite(bandwidth) ? bandwidth.toFixed(3) : 'NaN'}`,
      };
    }

    // ===== Filtros base =====
    const vavg = volumeAvg(cs, Math.max(20, config.VOL_AVG_LEN));
    const spike = L.volume >= (config.MR_SPIKE_VOL_FACTOR ?? 2.5) * vavg; // evita romper en tu contra
    if (spike) return { action: 'IDLE', reason: `spike_vol=${(L.volume / vavg).toFixed(2)}x` };

    // RSI desde el mismo motor de features que usa ML (coherente Py/TS)
    const feats = computeFeatures(cs);
    const rsi = feats.rsi;

    const eps = config.MR_TOUCH_EPS ?? 0.001;
    const nearLower = Number.isFinite(lower) && L.close <= lower * (1 + eps);
    const nearUpper = Number.isFinite(upper) && L.close >= upper * (1 - eps);

    const redStreak = countStreak(cs, 'red');
    const greenStreak = countStreak(cs, 'green');
    const needStreak = Math.max(1, config.MR_MIN_STREAK ?? 2);

    // Sesgo suave por MAs 5m (si hay una tendencia clara, evitar MR agresivo)
    const ema25_5m = ema(closes, 25).pop()!;
    const ema99_5m = ema(closes, 99).pop()!;
    const bullMA = ema25_5m > ema99_5m;
    const bearMA = ema25_5m < ema99_5m;

    // ===== Lado LONG (comprar extremo inferior) =====
    const longOk =
      (config as any).ALLOW_LONGS &&
      nearLower &&
      rsi <= (config.MR_RSI_LOW ?? 32) &&
      redStreak >= needStreak &&
      !bearMA; // evita pelear una caída clara en 5m

    if (longOk) {
      return {
        action: 'ENTER_LONG',
        reason: `MR_long rsi=${rsi.toFixed(1)} streak=${redStreak} bw=${bandwidth.toFixed(3)} adx=${adxNow.toFixed(1)}`,
      };
    }

    // ===== Lado SHORT (vender extremo superior) =====
    // Shorts más estrictos si MR_STRICT_SHORTS=1
    let extraShortOK = true;
    if (config.MR_STRICT_SHORTS) {
      if (config.MR_SHORT_CONFIRM_1H) {
        extraShortOK = await confirmBearOn1h(exchange, symbol, config.MR_SHORT_1H_ADX_MIN ?? 18);
      } else {
        // Como mínimo, evita ir contra un 5m claramente alcista
        extraShortOK = !bullMA;
      }
    }

    const shortOk =
      (config as any).ALLOW_SHORTS &&
      nearUpper &&
      rsi >= (config.MR_RSI_HIGH ?? 68) &&
      greenStreak >= needStreak &&
      extraShortOK;

    if (shortOk) {
      return {
        action: 'ENTER_SHORT',
        reason: `MR_short rsi=${rsi.toFixed(1)} streak=${greenStreak} bw=${bandwidth.toFixed(3)} adx=${adxNow.toFixed(1)} 1hOK=${config.MR_SHORT_CONFIRM_1H ? extraShortOK : true}`,
      };
    }

    return {
      action: 'IDLE',
      reason: `mr_filters nearL=${!!nearLower} nearU=${!!nearUpper} rsi=${rsi.toFixed(1)} red=${redStreak} green=${greenStreak} bw=${Number.isFinite(bandwidth) ? bandwidth.toFixed(3) : 'NaN'} adx=${adxNow.toFixed(1)}`,
    };
  },
};
