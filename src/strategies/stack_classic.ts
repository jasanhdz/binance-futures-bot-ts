// src/strategies/stack_classic.ts
import { Strategy, StrategyContext } from './types';
import { last, volumeAvg, countStreak } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';
import { sma, adx as adxCalc } from '../core/indicators/adx'; // ← usamos ADX solo como feature
import { computeFeatures } from '../ml/features'; // para RSI (MR) y para ML base
import { predictLong, predictShort } from '../ml/adapter'; // ← para mlMargin (solo feature)
import { predictLoss } from '../ml/antiLoss'; // ← anti-loss ONNX

function stdev(arr: number[], n = 20) {
  const k = Math.min(arr.length, n);
  if (k <= 1) return NaN;
  const s = arr.slice(-k);
  const m = s.reduce((a, b) => a + b, 0) / k;
  const v = s.reduce((a, b) => a + (b - m) * (b - m), 0) / (k - 1);
  return Math.sqrt(Math.max(0, v));
}

// Confirmación bajista en 1h SIN ADX (solo EMAs)
async function confirmBearOn1h(exchange: any, symbol: string) {
  const c1h = await exchange.getCandles(symbol, '1h', 200);
  if (c1h.length < 30) return false;
  const closes = c1h.map((c: any) => c.close);
  const ema25_1h = ema(closes, 25).pop()!;
  const ema99_1h = ema(closes, 99).pop()!;
  return ema25_1h < ema99_1h;
}

// helpers anti-loss
function distToBandPct(side: 'LONG' | 'SHORT', price: number, upper: number, lower: number) {
  // LONG: distancia a banda superior (riesgo de sobre-extensión)
  // SHORT: distancia a banda inferior (riesgo de rebote)
  if (side === 'LONG') {
    return Number.isFinite(upper) ? (upper - price) / Math.max(1e-9, price) : 0;
  } else {
    return Number.isFinite(lower) ? (price - lower) / Math.max(1e-9, price) : 0;
  }
}

export const StackClassic: Strategy = {
  name: 'stack_classic',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config, now } = ctx;
    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 60) return { action: 'IDLE', reason: 'few_candles' };

    const L = last(cs);
    const closes = cs.map((c) => c.close);
    const highs = cs.map((c) => c.high);
    const lows = cs.map((c) => c.low);

    // Bollinger (para blockTop/MR y distancias anti-loss)
    const ma20 = sma(closes, 20);
    const sd20 = stdev(closes, 20);
    const upper = ma20 + 2 * sd20;
    const lower = ma20 - 2 * sd20;
    const bandwidth = Number.isFinite(ma20) && ma20 > 0 ? (upper - lower) / ma20 : NaN;

    // Sesgo por EMAs (como tu bot original)
    const ema25_5m = ema(closes, 25).pop()!;
    const ema99_5m = ema(closes, 99).pop()!;
    const bullMA = ema25_5m > ema99_5m;
    const bearMA = ema25_5m < ema99_5m;

    // ===== Features para anti-loss (sin gates): ADX real y mlMargin real =====
    // No filtra la señal base; solo alimenta al anti-loss.
    const { adx } = adxCalc(highs, lows, closes, 14);
    const adxNow = Number.isFinite(adx) ? (adx as number) : 0;

    // pLong/pShort solo para obtener mlMargin
    const baseFeats = computeFeatures(cs);
    let mlMargin = 0;
    try {
      const pL = predictLong(baseFeats);
      const pS = predictShort(baseFeats);
      mlMargin = Math.abs(pL - pS);
    } catch {
      mlMargin = 0; // fallback si aún no tienes los artefactos base
    }

    // ===== MR fallback SIN ADX gate (por compresión de bandas) =====
    const isRange =
      Number.isFinite(bandwidth) && bandwidth <= (config.STACKC_BB_WIDTH_MAX ?? 0.025);

    if (isRange && config.STACKC_RANGE_FALLBACK === 'MR') {
      const rsi = baseFeats.rsi;
      const vavg = volumeAvg(cs, Math.max(20, config.VOL_AVG_LEN));
      const eps = (config as any).MR_TOUCH_EPS ?? 0.001;
      const rsiLow = (config as any).MR_RSI_LOW ?? 32;
      const rsiHigh = (config as any).MR_RSI_HIGH ?? 68;

      const tooHighVol = L.volume > vavg * ((config as any).MR_SPIKE_VOL_FACTOR ?? 2.5);

      // LONG MR
      if (
        (config as any).ALLOW_LONGS &&
        Number.isFinite(lower) &&
        L.close <= lower * (1 + eps) &&
        rsi <= rsiLow &&
        !tooHighVol
      ) {
        // Anti-loss (LONG)
        const features = {
          adx: adxNow,
          mlMargin,
          vRatio: L.volume / Math.max(1e-9, vavg),
          distTopPct: distToBandPct('LONG', L.close, upper, lower),
          hour: new Date(now).getUTCHours(),
        };
        if ((config as any).ANTI_LOSS_ON) {
          const thrL = (config as any).ANTI_LOSS_THR_LONG ?? (config as any).ANTI_LOSS_THR ?? 0.78;
          const pLoss = await predictLoss(features);
          if (pLoss >= thrL)
            return {
              action: 'IDLE',
              reason: `ml_high_loss_prob p=${pLoss.toFixed(3)} thr=${thrL}`,
            };
          if (pLoss >= thrL + 0.1 && (config as any).ALLOW_REVERSE) {
            return {
              action: 'ENTER_SHORT',
              reason: `ml_reverse p=${pLoss.toFixed(3)} thr=${thrL}`,
            };
          }
        }
        return {
          action: 'ENTER_LONG',
          reason: `MR_fallback rsi=${rsi.toFixed(1)} bw=${bandwidth.toFixed(3)}`,
        };
      }

      // SHORT MR
      if (
        (config as any).ALLOW_SHORTS &&
        Number.isFinite(upper) &&
        L.close >= upper * (1 - eps) &&
        rsi >= rsiHigh &&
        !tooHighVol
      ) {
        // Anti-loss (SHORT)
        const features = {
          adx: adxNow,
          mlMargin,
          vRatio: L.volume / Math.max(1e-9, vavg),
          distTopPct: distToBandPct('SHORT', L.close, upper, lower),
          hour: new Date(now).getUTCHours(),
        };
        if ((config as any).ANTI_LOSS_ON) {
          const thrS = (config as any).ANTI_LOSS_THR_SHORT ?? (config as any).ANTI_LOSS_THR ?? 0.78;
          const pLoss = await predictLoss(features);
          if (pLoss >= thrS)
            return {
              action: 'IDLE',
              reason: `ml_high_loss_prob p=${pLoss.toFixed(3)} thr=${thrS}`,
            };
          if (pLoss >= thrS + 0.1 && (config as any).ALLOW_REVERSE) {
            return { action: 'ENTER_LONG', reason: `ml_reverse p=${pLoss.toFixed(3)} thr=${thrS}` };
          }
        }
        return {
          action: 'ENTER_SHORT',
          reason: `MR_fallback rsi=${rsi.toFixed(1)} bw=${bandwidth.toFixed(3)}`,
        };
      }

      return {
        action: 'IDLE',
        reason: `mr_filters bw=${Number.isFinite(bandwidth) ? bandwidth.toFixed(3) : 'NaN'}`,
      };
    }

    // ===== Stacking clásico (sin gates de ADX/ML en la activación) =====
    const vavg = volumeAvg(cs, Math.max(20, config.VOL_AVG_LEN));
    const vOkLong = L.volume >= (config.STACKC_VOL_FACTOR ?? 1.6) * vavg;
    const vOkShort = L.volume >= (config.STACKC_VOL_FACTOR_SHORT ?? 2.1) * vavg;

    const gStreak = countStreak(cs, 'green');
    const rStreak = countStreak(cs, 'red');

    // Anti-FOMO: bloquear longs si rompe banda superior
    const blockTop = !!config.STACKC_BLOCK_TOP && Number.isFinite(upper) && L.close > upper;

    // -------- LONG clásico --------
    if (
      (config as any).ALLOW_LONGS &&
      bullMA &&
      vOkLong &&
      gStreak >= (config.STACKC_GREEN_STREAK ?? 3) &&
      !blockTop
    ) {
      const features = {
        adx: adxNow,
        mlMargin,
        vRatio: L.volume / Math.max(1e-9, vavg),
        distTopPct: distToBandPct('LONG', L.close, upper, lower),
        hour: new Date(now).getUTCHours(),
      };
      if ((config as any).ANTI_LOSS_ON) {
        const thrL = (config as any).ANTI_LOSS_THR_LONG ?? (config as any).ANTI_LOSS_THR ?? 0.78;
        const pLoss = await predictLoss(features);
        if (pLoss >= thrL)
          return { action: 'IDLE', reason: `ml_high_loss_prob p=${pLoss.toFixed(3)} thr=${thrL}` };
        if (pLoss >= thrL + 0.1 && (config as any).ALLOW_REVERSE) {
          return { action: 'ENTER_SHORT', reason: `ml_reverse p=${pLoss.toFixed(3)} thr=${thrL}` };
        }
      }
      return {
        action: 'ENTER_LONG',
        reason: `stackClassic_long v=${(L.volume / vavg).toFixed(2)} gStreak=${gStreak}`,
      };
    }

    // -------- SHORT clásico (más estricto) --------
    let shortConfirm1h = true;
    if ((config as any).SHORT_CONFIRM_1H) {
      shortConfirm1h = await confirmBearOn1h(exchange, symbol);
    }
    if (
      (config as any).ALLOW_SHORTS &&
      bearMA &&
      vOkShort &&
      rStreak >= (config.STACKC_RED_STREAK ?? 4) &&
      shortConfirm1h
    ) {
      const features = {
        adx: adxNow,
        mlMargin,
        vRatio: L.volume / Math.max(1e-9, vavg),
        distTopPct: distToBandPct('SHORT', L.close, upper, lower),
        hour: new Date(now).getUTCHours(),
      };
      if ((config as any).ANTI_LOSS_ON) {
        const thrS = (config as any).ANTI_LOSS_THR_SHORT ?? (config as any).ANTI_LOSS_THR ?? 0.78;
        const pLoss = await predictLoss(features);
        if (pLoss >= thrS)
          return { action: 'IDLE', reason: `ml_high_loss_prob p=${pLoss.toFixed(3)} thr=${thrS}` };
        if (pLoss >= thrS + 0.1 && (config as any).ALLOW_REVERSE) {
          return { action: 'ENTER_LONG', reason: `ml_reverse p=${pLoss.toFixed(3)} thr=${thrS}` };
        }
      }
      return {
        action: 'ENTER_SHORT',
        reason: `stackClassic_short v=${(L.volume / vavg).toFixed(2)} rStreak=${rStreak} 1h=${shortConfirm1h}`,
      };
    }

    return {
      action: 'IDLE',
      reason: `stack_filters bullMA=${bullMA} bearMA=${bearMA} vL=${(L.volume / vavg).toFixed(2)} g=${gStreak} r=${rStreak} blockTop=${blockTop}`,
    };
  },
};
