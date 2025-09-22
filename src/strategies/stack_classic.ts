// src/strategies/stack_classic.ts
import { Strategy, StrategyContext } from './types';
import { last, volumeAvg, countStreak } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';
import { adx as adxCalc, sma } from '../core/indicators/adx';
import { computeFeatures } from '../ml/features';
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

async function confirmBearOn1h(exchange: any, symbol: string) {
  const c1h = await exchange.getCandles(symbol, '1h', 200);
  if (c1h.length < 30) return false;
  const closes = c1h.map((c: any) => c.close);
  const ema25_1h = ema(closes, 25).pop()!;
  const ema99_1h = ema(closes, 99).pop()!;
  return ema25_1h < ema99_1h;
}

// Estado global para cooldown entre trades MR
let lastMRTradeAt = 0;

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

    // ===== Bollinger Bands =====
    const ma20 = sma(closes, 20);
    const sd20 = stdev(closes, 20);
    const upper = ma20 + 2 * sd20;
    const lower = ma20 - 2 * sd20;
    const bandwidth = Number.isFinite(ma20) && ma20 > 0 ? (upper - lower) / ma20 : NaN;

    // ===== EMAs para tendencia =====
    const ema25_5m = ema(closes, 25).pop()!;
    const ema99_5m = ema(closes, 99).pop()!;
    const bullMA = ema25_5m > ema99_5m;
    const bearMA = ema25_5m < ema99_5m;

    // ===== Filtros básicos =====
    const maeLastBar = Math.abs(L.close - L.open) / L.open;
    const distTopPct = Number.isFinite(upper) ? (upper - L.close) / upper : 1;

    if (maeLastBar > 0.005) return { action: 'IDLE', reason: 'mae_0.5pct' };
    if (distTopPct < 0.003) return { action: 'IDLE', reason: 'too_close_bb_top' };

    // ===== Métricas para análisis =====
    const { adx } = adxCalc(highs, lows, closes, 14);
    const adxNow = Number.isFinite(adx) ? (adx as number) : 0;
    const featsAll = computeFeatures(cs);
    const pL = predictLong(featsAll);
    const pS = predictShort(featsAll);
    const mlMargin = Math.abs(pL - pS);
    const rsi = featsAll.rsi;

    const vavg = volumeAvg(cs, Math.max(20, (config as any).VOL_AVG_LEN ?? 20));
    const volRatio = L.volume / Math.max(1e-9, vavg);
    const hourUTC = new Date(now).getUTCHours();

    // ===== Anti-loss helpers =====
    const TH_LONG = Number((config as any).ANTI_LOSS_THR_LONG ?? 0.88);
    const TH_SHORT = Number((config as any).ANTI_LOSS_THR_SHORT ?? 0.82);
    const ALLOW_REVERSE = config.ALLOW_REVERSE;

    const buildAntiLossLong = () => ({
      adx: adxNow,
      mlMargin,
      vRatio: volRatio,
      distTopPct: Number.isFinite(upper) ? (upper - L.close) / Math.max(1e-9, L.close) : 0,
      hour: hourUTC,
    });

    const buildAntiLossShort = () => ({
      adx: adxNow,
      mlMargin,
      vRatio: volRatio,
      distTopPct: Number.isFinite(lower) ? (L.close - lower) / Math.max(1e-9, L.close) : 0,
      hour: hourUTC,
    });

    // ÚNICA EXCEPCIÓN: Confirmación de ruptura con volumen
    const canEnterShortOnPanic =
      rsi < 15 &&
      bandwidth < 0.01 && // Contracción (no expansión)
      volRatio > 3.0 && // Volumen masivo confirmando ruptura
      bearMA && // Tendencia bajista clara
      adx > 30; // Tendencia fuerte

    if (canEnterShortOnPanic) {
      // SHORT con stop muy ajustado
      return { action: 'ENTER_SHORT', reason: 'panic_breakout_confirmed' };
    }

    // ZONA 1: Contracción + RSI moderado (15-30) = INVERTIR
    if (bandwidth < 0.01 && rsi >= 15 && rsi <= 30) {
      // Era LONG perdedor → SHORT ganador
      return { action: 'ENTER_SHORT', reason: 'inverted_contraction' };
    }

    // ZONA 2: RSI Pánico (<15) = NO TRADE
    if (rsi < 15) {
      return { action: 'IDLE', reason: 'extreme_panic_avoid' };
    }

    // ZONA 3: Banda segura (bw 0.010-0.020) + RSI normal = MR tradicional
    if (bandwidth >= 0.01 && bandwidth <= 0.02 && rsi >= 25) {
      return { action: 'ENTER_LONG', reason: 'safe_reversal' };
    }

    // ZONA 4: Expansión + RSI bajo = NO TRADE
    if (bandwidth > 0.02 && rsi < 25) {
      return { action: 'IDLE', reason: 'expansion_trap' };
    }

    // ========== MEAN REVERSION CON PROTECCIONES CRÍTICAS ==========
    const isRange =
      Number.isFinite(bandwidth) && bandwidth <= (config.STACKC_BB_WIDTH_MAX ?? 0.025);

    if (isRange && (config as any).STACKC_RANGE_FALLBACK === 'MR') {
      const eps = (config as any).MR_TOUCH_EPS ?? 0.001;
      const rsiLow = (config as any).MR_RSI_LOW ?? 32;
      const rsiHigh = (config as any).MR_RSI_HIGH ?? 68;
      const tooHighVol = L.volume > vavg * ((config as any).MR_SPIKE_VOL_FACTOR ?? 2.5);

      // ===== CONFIGURACIÓN DE UMBRALES CRÍTICOS =====
      const CONTRACTION_THRESHOLD = Number((config as any).MR_CONTRACTION_THRESHOLD ?? 0.01);
      const EXPANSION_DANGER = Number((config as any).MR_MAX_BANDWIDTH ?? 0.02);
      const MIN_RSI_IN_EXPANSION = Number((config as any).MR_MIN_RSI_EXPANSION ?? 25);
      const EXTREME_RSI_LOW = Number((config as any).MR_EXTREME_RSI_LOW ?? 15);
      const EXTREME_RSI_HIGH = Number((config as any).MR_EXTREME_RSI_HIGH ?? 85);
      const MR_COOLDOWN_MS = Number((config as any).MR_COOLDOWN_MS ?? 300000); // 5 minutos

      // ===== COOLDOWN: No entrar si hubo trade MR reciente =====
      const timeSinceLastMR = now - lastMRTradeAt;
      if (timeSinceLastMR < MR_COOLDOWN_MS) {
        const secondsLeft = Math.ceil((MR_COOLDOWN_MS - timeSinceLastMR) / 1000);
        return {
          action: 'IDLE',
          reason: `mr_cooldown ${secondsLeft}s`,
        };
      }

      // ===== DETECCIÓN DE PATRONES PELIGROSOS =====

      // PATRÓN 1: Expansión con RSI extremo = TRAMPA MORTAL
      const isDangerousExpansion = bandwidth > EXPANSION_DANGER && rsi < MIN_RSI_IN_EXPANSION;
      if (isDangerousExpansion) {
        return {
          action: 'IDLE',
          reason: `mr_danger_expansion bw=${bandwidth.toFixed(3)} rsi=${rsi.toFixed(1)}`,
        };
      }

      // PATRÓN 2: RSI de pánico = NUNCA entrar
      const isPanicRSI = rsi < EXTREME_RSI_LOW;
      const isEuphoriaRSI = rsi > EXTREME_RSI_HIGH;

      // ===== CONDICIONES BASE PARA MR =====
      const longConditionBase =
        (config as any).ALLOW_LONGS &&
        Number.isFinite(lower) &&
        L.close <= lower * (1 + eps) &&
        rsi <= rsiLow &&
        !tooHighVol;

      const shortConditionBase =
        (config as any).ALLOW_SHORTS &&
        Number.isFinite(upper) &&
        L.close >= upper * (1 - eps) &&
        rsi >= rsiHigh &&
        !tooHighVol;

      // ===== DECISIÓN DE INVERSIÓN BASADA EN BANDWIDTH =====

      // CASO A: Contracción extrema (bw < 0.010) - INVERTIR señales si RSI extremo
      const isContractionPattern = bandwidth < CONTRACTION_THRESHOLD;

      // CASO B: Zona segura (0.010 <= bw <= 0.020) - MR tradicional
      const isSafeZone = bandwidth >= CONTRACTION_THRESHOLD && bandwidth <= EXPANSION_DANGER;

      // CASO C: Expansión moderada (bw > 0.020) con RSI normal - MR con cuidado
      const isModerateExpansion = bandwidth > EXPANSION_DANGER && rsi >= MIN_RSI_IN_EXPANSION;

      // ===== PROCESAMIENTO DE SEÑAL LONG =====
      if (longConditionBase) {
        // Verificar si es patrón perdedor que debemos invertir
        if (isContractionPattern && isPanicRSI) {
          // INVERTIR: Contracción + pánico = SHORT
          if ((config as any).ALLOW_SHORTS) {
            lastMRTradeAt = now; // Actualizar cooldown

            if (config.ANTI_LOSS_ON) {
              const pLoss = await predictLoss(buildAntiLossShort());
              if (pLoss > TH_SHORT) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
            }

            return {
              action: 'ENTER_SHORT',
              reason: `MR_inverted rsi=${rsi.toFixed(1)} bw=${bandwidth.toFixed(3)} [CONTRACTION_PANIC]`,
            };
          }
        } else if (isSafeZone && !isPanicRSI) {
          // NORMAL: Zona segura = LONG tradicional
          lastMRTradeAt = now;

          if (config.ANTI_LOSS_ON) {
            const pLoss = await predictLoss(buildAntiLossLong());
            if (pLoss > TH_LONG) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
          }

          return {
            action: 'ENTER_LONG',
            reason: `MR_safe rsi=${rsi.toFixed(1)} bw=${bandwidth.toFixed(3)}`,
          };
        } else if (isModerateExpansion) {
          // CUIDADO: Expansión moderada, solo si RSI no es extremo
          lastMRTradeAt = now;

          if (config.ANTI_LOSS_ON) {
            const pLoss = await predictLoss(buildAntiLossLong());
            if (pLoss > TH_LONG) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
          }

          return {
            action: 'ENTER_LONG',
            reason: `MR_moderate rsi=${rsi.toFixed(1)} bw=${bandwidth.toFixed(3)}`,
          };
        } else {
          // NO ENTRAR: Combinación peligrosa
          return {
            action: 'IDLE',
            reason: `mr_skip_long bw=${bandwidth.toFixed(3)} rsi=${rsi.toFixed(1)}`,
          };
        }
      }

      // ===== PROCESAMIENTO DE SEÑAL SHORT =====
      if (shortConditionBase) {
        // Verificar si es patrón perdedor que debemos invertir
        if (isContractionPattern && isEuphoriaRSI) {
          // INVERTIR: Contracción + euforia = LONG
          if ((config as any).ALLOW_LONGS) {
            lastMRTradeAt = now;

            if (config.ANTI_LOSS_ON) {
              const pLoss = await predictLoss(buildAntiLossLong());
              if (pLoss > TH_LONG) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
            }

            return {
              action: 'ENTER_LONG',
              reason: `MR_inverted rsi=${rsi.toFixed(1)} bw=${bandwidth.toFixed(3)} [CONTRACTION_EUPHORIA]`,
            };
          }
        } else if (isSafeZone && !isEuphoriaRSI) {
          // NORMAL: Zona segura = SHORT tradicional
          lastMRTradeAt = now;

          if (config.ANTI_LOSS_ON) {
            const pLoss = await predictLoss(buildAntiLossShort());
            if (pLoss > TH_SHORT) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
          }

          return {
            action: 'ENTER_SHORT',
            reason: `MR_safe rsi=${rsi.toFixed(1)} bw=${bandwidth.toFixed(3)}`,
          };
        } else {
          // NO ENTRAR: Combinación peligrosa
          return {
            action: 'IDLE',
            reason: `mr_skip_short bw=${bandwidth.toFixed(3)} rsi=${rsi.toFixed(1)}`,
          };
        }
      }

      return {
        action: 'IDLE',
        reason: `mr_no_signal bw=${bandwidth.toFixed(3)} rsi=${rsi.toFixed(1)}`,
      };
    }

    // ========== TREND FOLLOWING (SIN CAMBIOS) ==========
    const vOkLong = volRatio >= ((config as any).STACKC_VOL_FACTOR ?? 1.6) * vavg;
    const vOkShort = volRatio >= ((config as any).STACKC_VOL_FACTOR_SHORT ?? 2.1) * vavg;

    const gStreak = countStreak(cs, 'green');
    const rStreak = countStreak(cs, 'red');

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
        reason: `stackClassic_long v=${volRatio.toFixed(2)} gStreak=${gStreak}`,
      };
    }

    // -------- SHORT --------
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
        reason: `stackClassic_short v=${volRatio.toFixed(2)} rStreak=${rStreak} 1h=${shortConfirm1h}`,
      };
    }

    return {
      action: 'IDLE',
      reason: `stack_filters bullMA=${bullMA} bearMA=${bearMA} vL=${volRatio.toFixed(2)} g=${gStreak} r=${rStreak} blockTop=${blockTop}`,
    };
  },
};
