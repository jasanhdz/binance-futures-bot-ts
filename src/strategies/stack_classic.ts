// src/strategies/stack_classic.ts
import { Strategy, StrategyContext } from './types';
import { last, volumeAvg, countStreak } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';
import { adx as adxCalc, sma } from '../core/indicators/adx'; // SMA (Bollinger) y ADX solo como feature
import { computeFeatures } from '../ml/features'; // para RSI (MR) y pL/pS (mlMargin)
import { predictLong, predictShort } from '../ml/adapter';
import { predictLoss } from '../ml/antiLoss';

function stdev(arr: number[], n = 20) {
  const k = Math.min(arr.length, n);
  if (k <= 1) return NaN;
  const s = arr.slice(-k);
  const m = s.reduce((a, b) => a + b, 0) / k;
  const v = s.reduce((a, b) => a + (b - m) * (b - m), 0) / (k - 1);
  return Math.sqrt(Math.max(0, v));
}

// Confirmación bajista en 1h SIN gatear por ADX (solo EMAs)
async function confirmBearOn1h(exchange: any, symbol: string) {
  const c1h = await exchange.getCandles(symbol, '1h', 200);
  if (c1h.length < 30) return false;
  const closes = c1h.map((c: any) => c.close);
  const ema25_1h = ema(closes, 25).pop()!;
  const ema99_1h = ema(closes, 99).pop()!;
  return ema25_1h < ema99_1h;
}

export const StackClassic: Strategy = {
  name: 'stack_classic',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config, state, now } = ctx;
    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 60) return { action: 'IDLE', reason: 'few_candles' };

    if (state.mode !== 'IDLE') {
      return { action: 'IDLE', reason: 'not_idle' };
    }

    const L = last(cs);
    const closes = cs.map((c) => c.close);
    const highs = cs.map((c) => c.high);
    const lows = cs.map((c) => c.low);

    // ===== Bollinger (para blockTop y MR) =====
    const ma20 = sma(closes, 20);
    const sd20 = stdev(closes, 20);
    const upper = ma20 + 2 * sd20;
    const lower = ma20 - 2 * sd20;
    const bandwidth = Number.isFinite(ma20) && ma20 > 0 ? (upper - lower) / ma20 : NaN;

    // ===== Sesgo por EMAs (como tu bot original) =====
    const ema25_5m = ema(closes, 25).pop()!;
    const ema99_5m = ema(closes, 99).pop()!;
    const bullMA = ema25_5m > ema99_5m;
    const bearMA = ema25_5m < ema99_5m;

    // ===== Métricas compartidas para anti-loss (solo como FEATURES) =====
    const { adx } = adxCalc(highs, lows, closes, 14);
    const adxNow = Number.isFinite(adx) ? (adx as number) : 0;

    const featsAll = computeFeatures(cs); // contiene rsi y los inputs para tu adapter
    const pL = predictLong(featsAll);
    const pS = predictShort(featsAll);
    const mlMargin = Math.abs(pL - pS);

    const vavg = volumeAvg(cs, Math.max(20, (config as any).VOL_AVG_LEN ?? 20));
    const hourUTC = new Date(now).getUTCHours();

    // Umbrales del anti-loss (ENV/CONFIG, con defaults prudentes)
    const TH_LONG = Number((config as any).ANTI_LOSS_THR_LONG ?? 0.88);
    const TH_SHORT = Number((config as any).ANTI_LOSS_THR_SHORT ?? 0.82);
    const ALLOW_REVERSE = config.ALLOW_REVERSE;

    // Helpers para armar features por lado (distTopPct distinto para long/short)
    const buildAntiLossLong = () => ({
      adx: adxNow,
      mlMargin,
      vRatio: L.volume / Math.max(1e-9, vavg),
      distTopPct: Number.isFinite(upper) ? (upper - L.close) / Math.max(1e-9, L.close) : 0,
      hour: hourUTC,
    });
    const buildAntiLossShort = () => ({
      adx: adxNow,
      mlMargin,
      vRatio: L.volume / Math.max(1e-9, vavg),
      distTopPct: Number.isFinite(lower) ? (L.close - lower) / Math.max(1e-9, L.close) : 0,
      hour: hourUTC,
    });

    // ===== MR fallback SIN ADX gating (solo por compresión de bandas) =====
    const isRange =
      Number.isFinite(bandwidth) && bandwidth <= (config.STACKC_BB_WIDTH_MAX ?? 0.025);

    if (isRange && (config as any).STACKC_RANGE_FALLBACK === 'MR') {
      const rsi = featsAll.rsi;
      const eps = (config as any).MR_TOUCH_EPS ?? 0.001;
      const rsiLow = (config as any).MR_RSI_LOW ?? 32;
      const rsiHigh = (config as any).MR_RSI_HIGH ?? 68;
      const tooHighVol = L.volume > vavg * ((config as any).MR_SPIKE_VOL_FACTOR ?? 2.5);

      const longOk =
        (config as any).ALLOW_LONGS &&
        Number.isFinite(lower) &&
        L.close <= lower * (1 + eps) &&
        rsi <= rsiLow &&
        !tooHighVol;

      const shortOk =
        (config as any).ALLOW_SHORTS &&
        Number.isFinite(upper) &&
        L.close >= upper * (1 - eps) &&
        rsi >= rsiHigh &&
        !tooHighVol;

      if (longOk) {
        if (config.ANTI_LOSS_ON) {
          const pLoss = await predictLoss(buildAntiLossLong());
          if (pLoss > TH_LONG) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
          if (pLoss > Math.max(TH_LONG, 0.95) && ALLOW_REVERSE) {
            return { action: 'ENTER_SHORT', reason: 'ml_reverse' };
          }
        }
        return {
          action: 'ENTER_LONG',
          reason: `MR_fallback rsi=${rsi.toFixed(1)} bw=${bandwidth.toFixed(3)}`,
        };
      }
      if (shortOk) {
        if (config.ANTI_LOSS_ON) {
          const pLoss = await predictLoss(buildAntiLossShort());
          if (pLoss > TH_SHORT) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
          if (pLoss > Math.max(TH_SHORT, 0.9) && ALLOW_REVERSE) {
            return { action: 'ENTER_LONG', reason: 'ml_reverse' };
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

    // ===== Stacking clásico (sin gates ADX/ML) =====
    const vOkLong = L.volume >= ((config as any).STACKC_VOL_FACTOR ?? 1.6) * vavg;
    const vOkShort = L.volume >= ((config as any).STACKC_VOL_FACTOR_SHORT ?? 2.1) * vavg;

    const gStreak = countStreak(cs, 'green');
    const rStreak = countStreak(cs, 'red');

    // Bloqueo anti-FOMO: evitar long si cierra sobre banda superior (opcional)
    const blockTop =
      !!(config as any).STACKC_BLOCK_TOP && Number.isFinite(upper) && L.close > upper;

    // -------- LONG --------
    const longOk =
      (config as any).ALLOW_LONGS &&
      bullMA &&
      vOkLong &&
      gStreak >= ((config as any).STACKC_GREEN_STREAK ?? 3) &&
      !blockTop;

    if (longOk) {
      if (config.ANTI_LOSS_ON) {
        const pLoss = await predictLoss(buildAntiLossLong());
        if (pLoss > TH_LONG) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
        if (pLoss > Math.max(TH_LONG, 0.95) && ALLOW_REVERSE) {
          return { action: 'ENTER_SHORT', reason: 'ml_reverse' };
        }
      }
      return {
        action: 'ENTER_LONG',
        reason: `stackClassic_long v=${(L.volume / vavg).toFixed(2)} gStreak=${gStreak}`,
      };
    }

    // -------- SHORT (más estricto) --------
    let shortConfirm1h = true;
    if ((config as any).SHORT_CONFIRM_1H) {
      shortConfirm1h = await confirmBearOn1h(exchange, symbol);
    }

    const shortOk =
      (config as any).ALLOW_SHORTS &&
      bearMA &&
      vOkShort &&
      rStreak >= ((config as any).STACKC_RED_STREAK ?? 4) &&
      shortConfirm1h;

    if (shortOk) {
      if (config.ANTI_LOSS_ON) {
        const pLoss = await predictLoss(buildAntiLossShort());
        if (pLoss > TH_SHORT) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
        if (pLoss > Math.max(TH_SHORT, 0.9) && ALLOW_REVERSE) {
          return { action: 'ENTER_LONG', reason: 'ml_reverse' };
        }
      }
      return {
        action: 'ENTER_SHORT',
        reason: `stackClassic_short v=${(L.volume / vavg).toFixed(2)} rStreak=${rStreak} 1h=${shortConfirm1h}`,
      };
    }

    return {
      action: 'IDLE',
      reason: `stack_filters bullMA=${bullMA} bearMA=${bearMA} vL=${(L.volume / vavg).toFixed(
        2,
      )} g=${gStreak} r=${rStreak} blockTop=${blockTop}`,
    };
  },
};
