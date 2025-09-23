// src/strategies/stack_classic.ts
import { Strategy, StrategyContext } from './types';
import { last, volumeAvg, countStreak } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';
import { adx as adxCalc, sma } from '../core/indicators/adx';
import { computeFeatures } from '../ml/features';
import { predictLong, predictShort } from '../ml/adapter';
import { predictLoss } from '../ml/antiLoss';
import { COLORS, trendBadge, zoneBadge } from '../infra/fs/FsLogger';

function stdev(arr: number[], n = 20) {
  const k = Math.min(arr.length, n);
  if (k <= 1) return NaN;
  const s = arr.slice(-k);
  const m = s.reduce((a, b) => a + b, 0) / k;
  const v = s.reduce((a, b) => a + (b - m) * (b - m), 0) / (k - 1);
  return Math.sqrt(Math.max(0, v));
}

// Detectar niveles clave de soporte/resistencia
function findKeyLevels(candles: any[], sensitivity = 3) {
  if (candles.length < 50) return null;

  const last200 = candles.slice(-Math.min(200, candles.length));
  const pricePoints: number[] = [];

  // Recopilar todos los máximos y mínimos
  last200.forEach((c) => {
    pricePoints.push(c.high, c.low);
  });

  // Agrupar precios cercanos (dentro de 0.3%)
  const priceClusters: Map<number, number> = new Map();
  const clusterSize = 0.003; // 0.3%

  pricePoints.forEach((price) => {
    let foundCluster = false;
    for (const [key, count] of priceClusters.entries()) {
      if (Math.abs(price - key) / key < clusterSize) {
        priceClusters.set(key, count + 1);
        foundCluster = true;
        break;
      }
    }
    if (!foundCluster) {
      priceClusters.set(price, 1);
    }
  });

  // Filtrar clusters significativos
  const significantLevels = Array.from(priceClusters.entries())
    .filter(([_, count]) => count >= sensitivity)
    .map(([price, count]) => ({ price, strength: count }))
    .sort((a, b) => b.strength - a.strength);

  if (significantLevels.length < 2) return null;

  const currentPrice = candles[candles.length - 1].close;

  // Encontrar resistencia y soporte más cercanos
  const resistances = significantLevels.filter((l) => l.price > currentPrice);
  const supports = significantLevels.filter((l) => l.price < currentPrice);

  if (resistances.length === 0 || supports.length === 0) {
    // Si no hay niveles claros, usar máximo y mínimo del rango
    const highs = last200.map((c) => c.high);
    const lows = last200.map((c) => c.low);
    return {
      resistance: Math.max(...highs),
      support: Math.min(...lows),
      midPoint: (Math.max(...highs) + Math.min(...lows)) / 2,
    };
  }

  const resistance = resistances[0].price;
  const support = supports[0].price;
  const midPoint = (resistance + support) / 2;

  return { resistance, support, midPoint };
}

// Determinar zona de precio
function getPriceZone(price: number, levels: any) {
  if (!levels) return 'UNKNOWN';

  const distToSupport = (price - levels.support) / levels.support;
  const distToResistance = (levels.resistance - price) / levels.resistance;
  const range = levels.resistance - levels.support;
  const position = (price - levels.support) / range;

  // Zonas basadas en posición en el rango
  if (distToSupport < 0.005 || position < 0.15) return 'SUPPORT';
  if (distToResistance < 0.005 || position > 0.85) return 'RESISTANCE';
  if (position >= 0.4 && position <= 0.6) return 'MIDDLE';
  if (position < 0.4) return 'LOWER_RANGE';
  return 'UPPER_RANGE';
}

// Variables globales para memoria de tendencia
let lastStrongTrend: 'STRONG_BULL' | 'STRONG_BEAR' | null = null;
let lastStrongTrendAt = 0;
let trendChangeCount = 0;
let consecutiveNeutralCount = 0;
let lastTrendDirection: string = '';

// Detectar tendencia actual con memoria
function getTrendDirection(
  candles: any[],
  ema7: number[],
  ema25: number[],
  ema99: number[],
  now: number,
) {
  const last10 = candles.slice(-10);
  const last5 = candles.slice(-5);
  const currentPrice = candles[candles.length - 1].close;

  // Tendencia de 10 velas
  const trend10 = (last10[9].close - last10[0].close) / last10[0].close;

  // Tendencia de 5 velas (más reciente)
  const trend5 = (last5[4].close - last5[0].close) / last5[0].close;

  // Contar velas direccionales
  const recentReds10 = last10.filter((c) => c.close < c.open).length;
  const recentGreens10 = last10.filter((c) => c.close > c.open).length;

  // Posición respecto a EMAs
  const currentEma7 = ema7[ema7.length - 1];
  const currentEma25 = ema25[ema25.length - 1];
  const currentEma99 = ema99[ema99.length - 1];

  const aboveAllEmas =
    currentPrice > currentEma7 && currentPrice > currentEma25 && currentPrice > currentEma99;
  const belowAllEmas =
    currentPrice < currentEma7 && currentPrice < currentEma25 && currentPrice < currentEma99;

  // Estructura de EMAs
  const bullishStructure = currentEma7 > currentEma25 && currentEma25 > currentEma99;
  const bearishStructure = currentEma7 < currentEma25 && currentEma25 < currentEma99;

  // Determinar tendencia
  const strongBullish =
    trend10 > 0.003 && trend5 > 0.002 && recentGreens10 >= 7 && bullishStructure;
  const strongBearish =
    trend10 < -0.003 && trend5 < -0.002 && recentReds10 >= 7 && bearishStructure;

  const bullish = trend10 > 0.001 || (trend5 > 0.001 && aboveAllEmas);
  const bearish = trend10 < -0.001 || (trend5 < -0.001 && belowAllEmas);

  let direction = strongBullish
    ? 'STRONG_BULL'
    : strongBearish
      ? 'STRONG_BEAR'
      : bullish
        ? 'BULL'
        : bearish
          ? 'BEAR'
          : 'NEUTRAL';

  // Actualizar memoria de tendencia
  if (direction === 'STRONG_BULL' || direction === 'STRONG_BEAR') {
    lastStrongTrend = direction;
    lastStrongTrendAt = now;
    trendChangeCount = 0;
    consecutiveNeutralCount = 0;
  } else if (direction === 'NEUTRAL') {
    consecutiveNeutralCount++;
    if (lastTrendDirection !== 'NEUTRAL') {
      trendChangeCount++;
    }
  } else {
    consecutiveNeutralCount = 0;
  }

  lastTrendDirection = direction;

  return {
    direction,
    trend10,
    trend5,
    recentReds10,
    recentGreens10,
    aboveAllEmas,
    belowAllEmas,
    bullishStructure,
    bearishStructure,
  };
}

async function confirmBearOn1h(exchange: any, symbol: string) {
  const c1h = await exchange.getCandles(symbol, '1h', 200);
  if (c1h.length < 30) return false;
  const closes = c1h.map((c: any) => c.close);
  const ema25_1h = ema(closes, 25).pop()!;
  const ema99_1h = ema(closes, 99).pop()!;
  return ema25_1h < ema99_1h;
}

// Variables globales para control de cooldowns
let lastMRTradeAt = 0;
let lastMicroContractionAt = 0;
let consecutiveMicroTrades = 0;
let lastTradeResult: 'WIN' | 'LOSS' | null = null;
let lastSafeReversalAt = 0;
let lastZoneTrendAt = 0;

export const StackClassic: Strategy = {
  name: 'stack_classic',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config, state, now, logger } = ctx;
    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 60) return { action: 'IDLE', reason: 'few_candles' };

    // Obtener datos básicos ANTES de verificar el estado
    const L = last(cs);
    const closes = cs.map((c) => c.close);
    const highs = cs.map((c) => c.high);
    const lows = cs.map((c) => c.low);

    // EMAs para tendencia
    const ema7_5m = ema(closes, 7);
    const ema25_5m_array = ema(closes, 25);
    const ema99_5m_array = ema(closes, 99);

    // Análisis de tendencia
    const trendAnalysis = getTrendDirection(cs, ema7_5m, ema25_5m_array, ema99_5m_array, now);

    // ===== EXIT TEMPRANO POR CAMBIO DE TENDENCIA =====
    if (state.mode === 'LONG_RIDE' || state.mode === 'SHORT_RIDE') {
      const positionSide = state.mode === 'LONG_RIDE' ? 'LONG' : 'SHORT';

      // Exit inmediato en cambio FUERTE de tendencia
      if (positionSide === 'LONG' && trendAnalysis.direction === 'STRONG_BEAR') {
        return {
          action: 'EXIT',
          reason: `trend_reversal_bear T10:${(trendAnalysis.trend10 * 100).toFixed(2)}%`,
        };
      }

      if (positionSide === 'SHORT' && trendAnalysis.direction === 'STRONG_BULL') {
        return {
          action: 'EXIT',
          reason: `trend_reversal_bull T10:${(trendAnalysis.trend10 * 100).toFixed(2)}%`,
        };
      }

      // Exit con momentum fuerte opuesto
      if (
        positionSide === 'LONG' &&
        trendAnalysis.direction === 'BEAR' &&
        trendAnalysis.trend5 < -0.003
      ) {
        return {
          action: 'EXIT',
          reason: `bear_momentum T5:${(trendAnalysis.trend5 * 100).toFixed(2)}%`,
        };
      }

      if (
        positionSide === 'SHORT' &&
        trendAnalysis.direction === 'BULL' &&
        trendAnalysis.trend5 > 0.003
      ) {
        return {
          action: 'EXIT',
          reason: `bull_momentum T5:${(trendAnalysis.trend5 * 100).toFixed(2)}%`,
        };
      }
    }

    // ===== ESTRUCTURA DE MERCADO =====
    const keyLevels = findKeyLevels(cs);
    const priceZone = getPriceZone(L.close, keyLevels);

    // ===== Bollinger Bands =====
    const ma20 = sma(closes, 20);
    const sd20 = stdev(closes, 20);
    const upper = ma20 + 2 * sd20;
    const lower = ma20 - 2 * sd20;
    const bandwidth = Number.isFinite(ma20) && ma20 > 0 ? (upper - lower) / ma20 : NaN;

    const ema7_current = ema7_5m[ema7_5m.length - 1];
    const ema25_5m = ema25_5m_array[ema25_5m_array.length - 1];
    const ema99_5m = ema99_5m_array[ema99_5m_array.length - 1];

    const bullMA = ema25_5m > ema99_5m;
    const bearMA = ema25_5m < ema99_5m;

    // Verificar si hay tendencia fuerte reciente
    const timeSinceStrongTrend = now - lastStrongTrendAt;
    const TREND_MEMORY_MS = 900000; // 15 minutos
    const hasRecentStrongBear =
      lastStrongTrend === 'STRONG_BEAR' && timeSinceStrongTrend < TREND_MEMORY_MS;
    const hasRecentStrongBull =
      lastStrongTrend === 'STRONG_BULL' && timeSinceStrongTrend < TREND_MEMORY_MS;

    // Reset contador si cambiamos de zona
    if (priceZone !== 'MIDDLE') {
      consecutiveMicroTrades = 0;
    }

    // ===== Filtros básicos =====
    const maeLastBar = Math.abs(L.close - L.open) / L.open;
    const distTopPct = Number.isFinite(upper) ? (upper - L.close) / upper : 1;

    if (maeLastBar > 0.005) return { action: 'IDLE', reason: 'mae_0.5pct' };
    if (distTopPct < 0.001) return { action: 'IDLE', reason: 'too_close_bb_top' };

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

    // ===== NUEVO FILTRO: Volumen mínimo =====
    if (volRatio < 0.8) {
      return { action: 'IDLE', reason: `low_volume v=${volRatio.toFixed(2)}` };
    }

    // ===== Anti-loss helpers =====
    const TH_LONG = Number((config as any).ANTI_LOSS_THR_LONG ?? 0.88);
    const TH_SHORT = Number((config as any).ANTI_LOSS_THR_SHORT ?? 0.82);

    const price = L.close;
    const resistance = keyLevels?.resistance;
    const support = keyLevels?.support;
    const zone = priceZone;
    const trend = trendAnalysis.direction;
    const t10 = trendAnalysis.trend10 * 100;
    const t5 = trendAnalysis.trend5 * 100;
    const bbw = Number.isFinite(bandwidth) ? bandwidth * 100 : undefined;
    const ema7 = ema7_current;
    const ema25 = ema25_5m;
    const ema99 = ema99_5m;

    // Ahora sí verificar si está IDLE
    if (state.mode !== 'IDLE') {
      console.log(
        `trend: ${trendBadge(trend)} | zone: ${zoneBadge(zone)} | support: ${support} | price: ${price} | ROI: ${
          Math.sign(state.peakRoe!) === -1
            ? `${COLORS.RED}${state.peakRoe?.toFixed(2)}${COLORS.RESET}`
            : `${COLORS.GREEN}${state.peakRoe?.toFixed(2)}${COLORS.RESET}`
        }`,
      );
      return { action: 'IDLE', reason: 'not_idle' };
    }

    // Log para debugging
    if (keyLevels) {
      logger?.info('market_snapshot', {
        price,
        resistance,
        support,
        zone: zone,
        trend,
        t10,
        t5,
        rsi,
        adx: adxNow,
        bbw,
        ema7,
        ema25,
        ema99,
      });
    }

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

    // ===== SEÑAL ZONA + TENDENCIA (AJUSTADA) =====
    const timeSinceZoneTrend = now - lastZoneTrendAt;
    const ZONE_TREND_COOLDOWN_MS = 300000; // 5 minutos

    if (timeSinceZoneTrend >= ZONE_TREND_COOLDOWN_MS) {
      // SHORT en resistencia con tendencia bajista
      if (
        priceZone === 'RESISTANCE' &&
        (trendAnalysis.direction === 'BEAR' || trendAnalysis.direction === 'STRONG_BEAR') &&
        rsi > 55 &&
        rsi < 75 && // AJUSTADO: Era 38-65, ahora 55-75
        config.ALLOW_SHORTS
      ) {
        // NUEVO: Verificar que NO sea NEUTRAL reciente
        if (trendAnalysis.direction === 'BEAR' && consecutiveNeutralCount > 2) {
          return { action: 'IDLE', reason: 'bear_after_neutral_unreliable' };
        }

        // Validar que no esté subiendo muy rápido
        const last3 = cs.slice(-3);
        const risingFast =
          last3.every((c) => c.close > c.open) &&
          (last3[2].close - last3[0].close) / last3[0].close > 0.002;

        if (!risingFast) {
          lastZoneTrendAt = now;
          if (config.ANTI_LOSS_ON) {
            const pLoss = await predictLoss(buildAntiLossShort());
            if (pLoss > TH_SHORT) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
          }
          return {
            action: 'ENTER_SHORT',
            reason: `resistance_bear_zone rsi=${rsi.toFixed(1)}`,
          };
        }
      }

      // LONG en soporte con tendencia alcista
      if (
        priceZone === 'SUPPORT' &&
        (trendAnalysis.direction === 'BULL' || trendAnalysis.direction === 'STRONG_BULL') &&
        rsi > 25 &&
        rsi < 45 && // AJUSTADO: Era 35-62, ahora 25-45
        config.ALLOW_LONGS
      ) {
        // NUEVO: Verificar que NO sea NEUTRAL reciente
        if (trendAnalysis.direction === 'BULL' && consecutiveNeutralCount > 2) {
          return { action: 'IDLE', reason: 'bull_after_neutral_unreliable' };
        }

        const last3 = cs.slice(-3);
        const fallingFast =
          last3.every((c) => c.close < c.open) &&
          (last3[0].close - last3[2].close) / last3[0].close > 0.002;

        if (!fallingFast) {
          lastZoneTrendAt = now;
          if (config.ANTI_LOSS_ON) {
            const pLoss = await predictLoss(buildAntiLossLong());
            if (pLoss > TH_LONG) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
          }
          return {
            action: 'ENTER_LONG',
            reason: `support_bull_zone rsi=${rsi.toFixed(1)}`,
          };
        }
      }
    }

    // ===== SEÑAL 1: Contracción (RELAJADA) =====
    if (bandwidth < 0.012 && rsi >= 20 && rsi <= 40 && keyLevels) {
      // En SOPORTE
      if (priceZone === 'SUPPORT' || priceZone === 'LOWER_RANGE') {
        if (trendAnalysis.direction === 'BEAR' || hasRecentStrongBear) {
          if (config.ALLOW_SHORTS && rsi > 30) {
            return { action: 'ENTER_SHORT', reason: `bear_bounce @${L.close.toFixed(4)}` };
          }
          return { action: 'IDLE', reason: 'bear_trend_no_long_support' };
        } else if (config.ALLOW_LONGS) {
          if (config.ANTI_LOSS_ON) {
            const pLoss = await predictLoss(buildAntiLossLong());
            if (pLoss > TH_LONG) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
          }
          return { action: 'ENTER_LONG', reason: `bounce_support @${L.close.toFixed(4)}` };
        }
      }

      // En RESISTENCIA
      if (priceZone === 'RESISTANCE' || priceZone === 'UPPER_RANGE') {
        if (trendAnalysis.direction === 'BULL' || hasRecentStrongBull) {
          if (config.ALLOW_LONGS && rsi < 35) {
            return { action: 'ENTER_LONG', reason: `bull_pullback @${L.close.toFixed(4)}` };
          }
          return { action: 'IDLE', reason: 'bull_trend_no_short_resistance' };
        } else if (config.ALLOW_SHORTS) {
          if (config.ANTI_LOSS_ON) {
            const pLoss = await predictLoss(buildAntiLossShort());
            if (pLoss > TH_SHORT) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
          }
          return { action: 'ENTER_SHORT', reason: `reject_resistance @${L.close.toFixed(4)}` };
        }
      }

      return { action: 'IDLE', reason: `contraction_${priceZone.toLowerCase()}` };
    }

    // SEÑAL 2: RSI extremo - No operar
    if (rsi < 15 || rsi > 85) {
      return { action: 'IDLE', reason: 'extreme_rsi' };
    }

    // SEÑAL 3: Safe Reversal con VALIDACIÓN DE TENDENCIA
    if (bandwidth >= 0.007 && bandwidth <= 0.02 && keyLevels) {
      const timeSinceSafeReversal = now - lastSafeReversalAt;
      const SAFE_REVERSAL_COOLDOWN_MS = 300000; // 5 minutos

      if (timeSinceSafeReversal < SAFE_REVERSAL_COOLDOWN_MS) {
        const minutesLeft = Math.ceil((SAFE_REVERSAL_COOLDOWN_MS - timeSinceSafeReversal) / 60000);
        return { action: 'IDLE', reason: `safe_reversal_cooldown ${minutesLeft}m` };
      }

      if (priceZone === 'MIDDLE') {
        const lastCandles = cs.slice(-3);
        const fallingKnife = lastCandles.every((c) => c.close < c.open);
        const risingKnife = lastCandles.every((c) => c.close > c.open);

        if (hasRecentStrongBear || trendAnalysis.direction === 'BEAR') {
          if (rsi > 50 && config.ALLOW_SHORTS) {
            // AJUSTADO: Era 42, ahora 50
            lastSafeReversalAt = now;
            return { action: 'ENTER_SHORT', reason: `bear_trend_short rsi=${rsi.toFixed(1)}` };
          }
          return { action: 'IDLE', reason: 'bear_trend_wait_short_setup' };
        } else if (hasRecentStrongBull || trendAnalysis.direction === 'BULL') {
          if (rsi < 50 && config.ALLOW_LONGS) {
            // AJUSTADO: Era 58, ahora 50
            lastSafeReversalAt = now;
            return { action: 'ENTER_LONG', reason: `bull_trend_long rsi=${rsi.toFixed(1)}` };
          }
          return { action: 'IDLE', reason: 'bull_trend_wait_long_setup' };
        } else if (trendAnalysis.direction === 'NEUTRAL') {
          if (consecutiveNeutralCount < 3) {
            return { action: 'IDLE', reason: `trend_confirming ${consecutiveNeutralCount}/3` };
          }

          if (rsi < 45 && L.close <= keyLevels.midPoint && !fallingKnife) {
            if (config.ALLOW_LONGS && !hasRecentStrongBear) {
              lastSafeReversalAt = now;
              return {
                action: 'ENTER_LONG',
                reason: `neutral_confirmed_long rsi=${rsi.toFixed(1)}`,
              };
            }
          }
          if (rsi > 55 && L.close >= keyLevels.midPoint && !risingKnife) {
            if (config.ALLOW_SHORTS && !hasRecentStrongBull) {
              lastSafeReversalAt = now;
              return {
                action: 'ENTER_SHORT',
                reason: `neutral_confirmed_short rsi=${rsi.toFixed(1)}`,
              };
            }
          }
        }
      }

      // En LOWER_RANGE
      if (priceZone === 'LOWER_RANGE') {
        if (hasRecentStrongBear || trendAnalysis.direction === 'BEAR') {
          if (config.ALLOW_SHORTS && rsi > 45) {
            // AJUSTADO: Era 35, ahora 45
            return { action: 'ENTER_SHORT', reason: `bear_continuation` };
          }
          return { action: 'IDLE', reason: 'bear_trend_no_long_lower' };
        }
        if (
          !hasRecentStrongBear &&
          trendAnalysis.direction !== 'BEAR' &&
          rsi < 35 &&
          config.ALLOW_LONGS
        ) {
          return { action: 'ENTER_LONG', reason: `oversold_bounce` };
        }
      }

      // En UPPER_RANGE
      if (priceZone === 'UPPER_RANGE') {
        if (hasRecentStrongBull || trendAnalysis.direction === 'BULL') {
          if (config.ALLOW_LONGS && rsi < 55) {
            // AJUSTADO: Era 65, ahora 55
            return { action: 'ENTER_LONG', reason: `bull_continuation` };
          }
          return { action: 'IDLE', reason: 'bull_trend_no_short_upper' };
        }
        if (
          !hasRecentStrongBull &&
          trendAnalysis.direction !== 'BULL' &&
          rsi > 65 &&
          config.ALLOW_SHORTS
        ) {
          return { action: 'ENTER_SHORT', reason: `overbought_reversal` };
        }
      }
    }

    // SEÑAL: Micro contracción
    if (bandwidth < 0.01 && bandwidth >= 0.006 && priceZone === 'MIDDLE' && keyLevels) {
      const timeSinceLastMicro = now - lastMicroContractionAt;
      const MICRO_COOLDOWN_MS = 600000; // 10 minutos
      const MAX_CONSECUTIVE_MICRO = 2;

      if (timeSinceLastMicro < MICRO_COOLDOWN_MS) {
        const minutesLeft = Math.ceil((MICRO_COOLDOWN_MS - timeSinceLastMicro) / 60000);
        return { action: 'IDLE', reason: `micro_cooldown ${minutesLeft}m` };
      }

      if (consecutiveMicroTrades >= MAX_CONSECUTIVE_MICRO) {
        return { action: 'IDLE', reason: `micro_limit_reached` };
      }

      // NUEVO: No hacer micro trades si hay muchos NEUTRAL recientes
      if (consecutiveNeutralCount > 3) {
        return { action: 'IDLE', reason: 'micro_neutral_market' };
      }

      if (hasRecentStrongBear || trendAnalysis.direction === 'BEAR') {
        if (bearMA && rsi > 45 && rsi < 65 && config.ALLOW_SHORTS) {
          lastMicroContractionAt = now;
          consecutiveMicroTrades++;
          return { action: 'ENTER_SHORT', reason: `micro_bear rsi=${rsi.toFixed(1)}` };
        }
      } else if (hasRecentStrongBull || trendAnalysis.direction === 'BULL') {
        if (bullMA && rsi > 35 && rsi < 55 && config.ALLOW_LONGS) {
          lastMicroContractionAt = now;
          consecutiveMicroTrades++;
          return { action: 'ENTER_LONG', reason: `micro_bull rsi=${rsi.toFixed(1)}` };
        }
      }
    }

    // Expansión peligrosa
    if (bandwidth > 0.02 && rsi < 25) {
      return { action: 'IDLE', reason: 'expansion_trap' };
    }

    // ========== MEAN REVERSION ==========
    const isRange =
      Number.isFinite(bandwidth) && bandwidth <= (config.STACKC_BB_WIDTH_MAX ?? 0.025);

    if (isRange && (config as any).STACKC_RANGE_FALLBACK === 'MR' && keyLevels) {
      const eps = (config as any).MR_TOUCH_EPS ?? 0.001;
      const rsiLow = (config as any).MR_RSI_LOW ?? 32;
      const rsiHigh = (config as any).MR_RSI_HIGH ?? 68;
      const tooHighVol = L.volume > vavg * ((config as any).MR_SPIKE_VOL_FACTOR ?? 2.5);
      const MR_COOLDOWN_MS = Number((config as any).MR_COOLDOWN_MS ?? 300000);

      const timeSinceLastMR = now - lastMRTradeAt;
      if (timeSinceLastMR < MR_COOLDOWN_MS) {
        const secondsLeft = Math.ceil((MR_COOLDOWN_MS - timeSinceLastMR) / 1000);
        return { action: 'IDLE', reason: `mr_cooldown ${secondsLeft}s` };
      }

      if (hasRecentStrongBear || trendAnalysis.direction === 'BEAR') {
        if (
          (config as any).ALLOW_SHORTS &&
          Number.isFinite(upper) &&
          L.close >= upper * (1 - eps) &&
          rsi >= Math.max(rsiHigh - 10, 58) && // AJUSTADO: Mínimo 58
          !tooHighVol
        ) {
          lastMRTradeAt = now;
          return { action: 'ENTER_SHORT', reason: `MR_bear rsi=${rsi.toFixed(1)}` };
        }
      } else if (hasRecentStrongBull || trendAnalysis.direction === 'BULL') {
        if (
          (config as any).ALLOW_LONGS &&
          Number.isFinite(lower) &&
          L.close <= lower * (1 + eps) &&
          rsi <= Math.min(rsiLow + 10, 42) && // AJUSTADO: Máximo 42
          !tooHighVol
        ) {
          lastMRTradeAt = now;
          return { action: 'ENTER_LONG', reason: `MR_bull rsi=${rsi.toFixed(1)}` };
        }
      }
    }

    // ========== TREND FOLLOWING ==========
    const vOkLong = volRatio >= ((config as any).STACKC_VOL_FACTOR ?? 1.6);
    const vOkShort = volRatio >= ((config as any).STACKC_VOL_FACTOR_SHORT ?? 2.1);
    const gStreak = countStreak(cs, 'green');
    const rStreak = countStreak(cs, 'red');

    const longOk =
      (config as any).ALLOW_LONGS &&
      (trendAnalysis.direction === 'BULL' || trendAnalysis.direction === 'STRONG_BULL') &&
      !hasRecentStrongBear &&
      bullMA &&
      vOkLong &&
      gStreak >= ((config as any).STACKC_GREEN_STREAK ?? 3) &&
      priceZone !== 'RESISTANCE' &&
      rsi < 70; // NUEVO: No entrar si RSI muy alto

    if (longOk) {
      if (config.ANTI_LOSS_ON) {
        const pLoss = await predictLoss(buildAntiLossLong());
        if (pLoss > TH_LONG) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
      }
      return {
        action: 'ENTER_LONG',
        reason: `trend_long v=${volRatio.toFixed(2)} streak=${gStreak}`,
      };
    }

    let shortConfirm1h = true;
    if ((config as any).SHORT_CONFIRM_1H) {
      shortConfirm1h = await confirmBearOn1h(exchange, symbol);
    }

    const shortOk =
      (config as any).ALLOW_SHORTS &&
      (trendAnalysis.direction === 'BEAR' || trendAnalysis.direction === 'STRONG_BEAR') &&
      !hasRecentStrongBull &&
      bearMA &&
      vOkShort &&
      rStreak >= ((config as any).STACKC_RED_STREAK ?? 4) &&
      shortConfirm1h &&
      priceZone !== 'SUPPORT' &&
      rsi > 30; // NUEVO: No entrar si RSI muy bajo

    if (shortOk) {
      if (config.ANTI_LOSS_ON) {
        const pLoss = await predictLoss(buildAntiLossShort());
        if (pLoss > TH_SHORT) return { action: 'IDLE', reason: 'ml_high_loss_prob' };
      }
      return {
        action: 'ENTER_SHORT',
        reason: `trend_short v=${volRatio.toFixed(2)} streak=${rStreak}`,
      };
    }

    return {
      action: 'IDLE',
      reason: `no_setup zone=${priceZone} trend=${trendAnalysis.direction} rsi=${rsi.toFixed(1)}`,
    };
  },
};
