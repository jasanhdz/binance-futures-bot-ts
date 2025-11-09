/**
 * ML Advanced Strategy - Optimized for LINK, SOL, BNB
 * 
 * Uses best timeframes and thresholds per symbol based on walk-forward validation:
 * - LINK: 15m both directions (balanced)
 * - SOL: 5m longs + 15m shorts (dual timeframe)
 * - BNB: 15m shorts only (specialized)
 */

import { Strategy, StrategyContext } from './types';
import { Candle, Signal } from '../core/types';
import {
  MlProbabilityServiceClient,
  MlProbabilityResponse,
  MlServiceError,
} from '../ml/ml_probability_service';
import { COLORS } from '../infra/fs/FsLogger';
import { ema } from '../core/indicators/ema';
import { atr } from '../core/indicators/atr';
import { rsiSMA } from '../core/utils/features';

// ============================================================================
// SYMBOL-SPECIFIC CONFIGURATION
// ============================================================================

interface SymbolConfig {
  // Timeframes
  longTimeframe: string | null;
  shortTimeframe: string | null;
  
  // Confidence thresholds
  longThreshold: number | null;
  shortThreshold: number | null;
  
  // Strategy behavior
  useBothDirections: boolean;
  requireTechnicalConfirmation: boolean;
  minConfirmations: number;
  
  // Risk management
  maxStopLossPercent: number;
  riskRewardRatio: number;
  positionSizePercent: number;
}

const SYMBOL_CONFIGS: Record<string, SymbolConfig> = {
  LINKUSDT: {
    // TIER 2 - Best balanced model (Score: 6.8/10)
    longTimeframe: '15m',
    shortTimeframe: '15m',
    // longThreshold: 0.65,
    // shortThreshold: 0.70,
    longThreshold: 0.45,
    shortThreshold: 0.50,
    useBothDirections: true,
    requireTechnicalConfirmation: true,
    minConfirmations: 3, // 3 of 4 required
    maxStopLossPercent: 0.025, // 2.5%
    riskRewardRatio: 1.5,
    positionSizePercent: 0.01, // 1%
  },
  
  SOLUSDT: {
    // TIER 2 - Dual timeframe specialist (Score: 6.5/10)
    // 5m for longs (61.9% recall), 15m for shorts (55.3% recall)
    longTimeframe: '5m',
    shortTimeframe: '15m',
    // longThreshold: 0.70, // Higher threshold for 5m longs
    // shortThreshold: 0.65,
    longThreshold: 0.50, // Higher threshold for 5m longs
    shortThreshold: 0.45,
    useBothDirections: true,
    requireTechnicalConfirmation: true,
    minConfirmations: 2, // 2 of 4 for shorts, 4 of 4 for longs
    maxStopLossPercent: 0.030, // 3% (more volatile)
    riskRewardRatio: 1.5,
    positionSizePercent: 0.008, // 0.8% (more volatile)
  },
  
  BNBUSDT: {
    // TIER 2 - Short-only specialist (Score: 6.2/10)
    // 83.4% recall on shorts in 15m!
    longTimeframe: null, // DO NOT USE LONGS
    shortTimeframe: '15m',
    longThreshold: null,
    // shortThreshold: 0.60, // Lower threshold (high recall)
    shortThreshold: 0.50, // Lower threshold (high recall)
    useBothDirections: false, // SHORTS ONLY
    requireTechnicalConfirmation: true,
    minConfirmations: 1, // Just basic confirmation
    maxStopLossPercent: 0.025,
    riskRewardRatio: 1.5,
    positionSizePercent: 0.0075, // 0.75%
  },
};

type MacdLines = {
  macdLine: number;
  signalLine: number;
};

function computeMacdLines(
  values: number[],
  fastLength = 12,
  slowLength = 26,
  signalLength = 9,
): MacdLines | null {
  if (values.length < slowLength + signalLength) {
    return null;
  }

  const fastEma = ema(values, fastLength);
  const slowEma = ema(values, slowLength);
  const macdSeries = fastEma.map((fast, idx) => fast - slowEma[idx]);
  const signalSeries = ema(macdSeries, signalLength);

  const macdLine = macdSeries[macdSeries.length - 1];
  const signalLine = signalSeries[signalSeries.length - 1];

  if (!Number.isFinite(macdLine) || !Number.isFinite(signalLine)) {
    return null;
  }

  return { macdLine, signalLine };
}

// ============================================================================
// TECHNICAL CONFIRMATION CHECKS
// ============================================================================

interface TechnicalConfirmations {
  rsiOk: boolean;
  macdOk: boolean;
  volumeOk: boolean;
  trendOk: boolean;
  score: number;
}

type DirectionEvaluation = {
  signal: Signal | null;
  reason?: string;
};

function formatColored(value: number | null | string, color: string) {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'string') {
    return `${color}${value}${COLORS.RESET}`;
  }
  return `${color}${value.toFixed(2)}${COLORS.RESET}`;
}

function formatTimeframeSegment(
  timeframe: string,
  probs?: { long_prob?: number | null; short_prob?: number | null },
) {
  const longVal = probs?.long_prob ?? null;
  const shortVal = probs?.short_prob ?? null;
  if (longVal === null && shortVal === null) {
    return `${timeframe} long=n/a short=n/a`;
  }

  const higher =
    Math.max(
      longVal === null ? Number.NEGATIVE_INFINITY : longVal,
      shortVal === null ? Number.NEGATIVE_INFINITY : shortVal,
    ) ?? Number.NEGATIVE_INFINITY;

  const longColor = longVal !== null && longVal === higher ? COLORS.CYAN : COLORS.RESET;
  const shortColor = shortVal !== null && shortVal === higher ? COLORS.CYAN : COLORS.RESET;

  const longDisplay =
    longVal === null ? 'n/a' : formatColored(longVal, longColor);
  const shortDisplay =
    shortVal === null ? 'n/a' : formatColored(shortVal, shortColor);

  return `${timeframe} long=${longDisplay}/short=${shortDisplay}`;
}

function buildPredictionSummary(
  symbol: string,
  predictions: Record<string, MlProbabilityResponse>,
): string[] {
  const segments: string[] = [];
  segments.push(`symbol=${formatColored(symbol, COLORS.CYAN)}`);

  Object.entries(predictions)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([tf, probs]) => {
      segments.push(formatTimeframeSegment(tf, probs));
    });

  return segments;
}

function calculateTechnicalConfirmations(
  candles: Candle[],
  direction: 'long' | 'short'
): TechnicalConfirmations {
  if (candles.length < 100) {
    return {
      rsiOk: false,
      macdOk: false,
      volumeOk: false,
      trendOk: false,
      score: 0,
    };
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  // RSI confirmation (bounded to avoid NaNs)
  const currentRsi = rsiSMA(closes, 14);
  const rsiOk = currentRsi > 30 && currentRsi < 70;

  // MACD confirmation
  const macdLines = computeMacdLines(closes);
  const macdOk = macdLines
    ? direction === 'long'
      ? macdLines.macdLine > macdLines.signalLine
      : macdLines.macdLine < macdLines.signalLine
    : false;

  // Volume confirmation (30% above rolling avg as momentum proxy)
  const recentVolumes = volumes.slice(-20);
  const avgVolume =
    recentVolumes.length > 0
      ? recentVolumes.reduce((sum, v) => sum + v, 0) / recentVolumes.length
      : 0;
  const currentVolume = volumes[volumes.length - 1];
  const volumeOk =
    avgVolume > 0 ? currentVolume > avgVolume * 1.3 : Number.isFinite(currentVolume) && currentVolume > 0;

  // Trend confirmation (EMA 50)
  const ema50 = ema(closes, 50);
  const currentPrice = closes[closes.length - 1];
  const currentEma = ema50[ema50.length - 1];
  const trendOk =
    direction === 'long' ? currentPrice > currentEma : currentPrice < currentEma;

  const score = [rsiOk, macdOk, volumeOk, trendOk].filter(Boolean).length;

  return { rsiOk, macdOk, volumeOk, trendOk, score };
}

// ============================================================================
// RISK MANAGEMENT
// ============================================================================

function calculateStopLoss(
  candles: Candle[],
  entryPrice: number,
  direction: 'long' | 'short',
  maxStopPercent: number
): number {
  const percentStop =
    direction === 'long'
      ? entryPrice * (1 - maxStopPercent)
      : entryPrice * (1 + maxStopPercent);

  if (candles.length < 20) {
    return percentStop;
  }

  const atrLen = 14;
  const atrWindow = candles.slice(-Math.max(atrLen + 1, 30));
  let atrStop: number | null = null;

  if (atrWindow.length >= atrLen + 1) {
    const atrValue = atr(atrWindow, atrLen);
    if (Number.isFinite(atrValue)) {
      const atrRisk = atrValue * 2; // 2x ATR cushion
      atrStop =
        direction === 'long' ? entryPrice - atrRisk : entryPrice + atrRisk;
    }
  }

  if (atrStop === null) {
    return percentStop;
  }

  return direction === 'long'
    ? Math.max(atrStop, percentStop)
    : Math.min(atrStop, percentStop);
}

// ============================================================================
// MAIN STRATEGY CLASS
// ============================================================================

export class MlAdvancedStrategy implements Strategy {
  readonly name = 'ml_advanced';
  timeframe: string;

  private readonly client: MlProbabilityServiceClient;
  private readonly defaultHistoryBars = 512;

  constructor(timeframe: string = '15m') {
    this.timeframe = timeframe;
    this.client = new MlProbabilityServiceClient();
  }

  private resolveHistoryBars(config: StrategyContext['config']): number {
    const cfgValue = Number((config as any).ML_HISTORY_BARS ?? 0);
    if (Number.isFinite(cfgValue) && cfgValue > 0) {
      return Math.max(cfgValue, this.defaultHistoryBars);
    }
    return this.defaultHistoryBars;
  }

  async evaluate(ctx: StrategyContext): Promise<Signal> {
    const { symbol, exchange, logger, config } = ctx;

    const symbolConfig = SYMBOL_CONFIGS[symbol];
    if (!symbolConfig) {
      logger?.warn('ml_advanced_symbol_disabled', { symbol });
      return { action: 'IDLE', reason: 'ml_advanced_symbol_disabled' };
    }

    logger?.info('ml_advanced_evaluating', { symbol });

    const timeframesNeeded = new Set<string>();
    if (symbolConfig.longTimeframe) timeframesNeeded.add(symbolConfig.longTimeframe);
    if (symbolConfig.shortTimeframe) timeframesNeeded.add(symbolConfig.shortTimeframe);

    if (timeframesNeeded.size === 0) {
      logger?.warn('ml_advanced_no_timeframes', { symbol });
      return { action: 'IDLE', reason: 'ml_advanced_no_timeframes' };
    }

    try {
      const historyBars = this.resolveHistoryBars(ctx.config);
      const candlesByTf: Record<string, Candle[]> = {};
      const predictions: Record<string, MlProbabilityResponse> = {};

      for (const tf of timeframesNeeded) {
        const candles = await exchange.getCandles(symbol, tf, historyBars);
        if (!candles || candles.length < 100) {
          logger?.warn('ml_advanced_few_candles', { symbol, timeframe: tf, have: candles?.length });
          return { action: 'IDLE', reason: 'ml_advanced_few_candles' };
        }
        candlesByTf[tf] = candles;

        try {
          const prediction = await this.client.fetchProbabilities({
            symbol,
            candles,
            timeframe: tf,
          });
          predictions[tf] = prediction;
        } catch (error) {
          if (error instanceof MlServiceError) {
            logger?.warn('ml_advanced_prediction_error', {
              symbol,
              timeframe: tf,
              status: error.status,
              message: error.message,
            });
            return {
              action: 'IDLE',
              reason: `ml_service_${error.status ?? 'error'}`,
              diagnostics: { symbol, timeframe: tf, status: error.status },
            };
          }
          logger?.error('ml_advanced_prediction_error', {
            symbol,
            timeframe: tf,
            error: (error as Error)?.message ?? String(error),
          });
          return { action: 'IDLE', reason: 'ml_advanced_prediction_error' };
        }
      }

      const summarySegments = buildPredictionSummary(symbol, predictions);
      const rejectionReasons: string[] = [];

      let longSignal: Signal | null = null;
      if (symbolConfig.longTimeframe && symbolConfig.longThreshold !== null) {
        const longResult = await this.evaluateLongSignal({
          symbol,
          config: symbolConfig,
          prediction: predictions[symbolConfig.longTimeframe],
          candles: candlesByTf[symbolConfig.longTimeframe],
          logger,
          summarySegments,
        });
        longSignal = longResult.signal;
        if (!longSignal && longResult.reason) {
          rejectionReasons.push(longResult.reason);
        }
      }

      let shortSignal: Signal | null = null;
      if (symbolConfig.shortTimeframe && symbolConfig.shortThreshold !== null) {
        const shortResult = await this.evaluateShortSignal({
          symbol,
          config: symbolConfig,
          prediction: predictions[symbolConfig.shortTimeframe],
          candles: candlesByTf[symbolConfig.shortTimeframe],
          logger,
          summarySegments,
        });
        shortSignal = shortResult.signal;
        if (!shortSignal && shortResult.reason) {
          rejectionReasons.push(shortResult.reason);
        }
      }

      if (longSignal && shortSignal) {
        const longScore = longSignal.confidence ?? 0;
        const shortScore = shortSignal.confidence ?? 0;
        return longScore >= shortScore ? longSignal : shortSignal;
      }

      if (longSignal) return longSignal;
      if (shortSignal) return shortSignal;

      const baseReason =
        rejectionReasons.length > 0
          ? `ml_advanced_no_signal | ${rejectionReasons.join(' | ')}`
          : 'ml_advanced_no_signal';
      const decoratedReason =
        summarySegments.length > 0
          ? `${baseReason} | ${summarySegments.join(' | ')}`
          : baseReason;
      return { action: 'IDLE', reason: decoratedReason };
    } catch (error) {
      logger?.error('ml_advanced_runtime_error', {
        symbol,
        error: (error as Error)?.message ?? String(error),
      });
      return { action: 'IDLE', reason: 'ml_advanced_runtime_error' };
    }
  }

  private async evaluateLongSignal(params: {
    symbol: string;
    config: SymbolConfig;
    prediction?: MlProbabilityResponse;
    candles?: Candle[];
    logger?: StrategyContext['logger'];
    summarySegments: string[];
  }): Promise<DirectionEvaluation> {
    const { symbol, config, prediction, candles, logger, summarySegments } = params;
    if (!prediction || !candles?.length) {
      logger?.warn('ml_advanced_missing_long_prediction', {
        symbol,
        timeframe: config.longTimeframe,
      });
      return {
        signal: null,
        reason: `long_reject=prediction_missing_tf=${config.longTimeframe}`,
      };
    }

    const longProb = prediction.long_prob;
    const longThreshold = config.longThreshold!;

    // Check confidence threshold
    if (longProb < longThreshold) {
      logger?.debug(
        `[ML_ADVANCED] ${symbol} LONG probability ${longProb.toFixed(2)} < threshold ${longThreshold}`
      );
      return {
        signal: null,
        reason: `long_reject=prob${longProb.toFixed(2)}<th${longThreshold.toFixed(2)}`,
      };
    }

    // Technical confirmations
    const confirmations = calculateTechnicalConfirmations(candles, 'long');
    const requiredConfirmations = symbol === 'SOLUSDT' 
      ? 4  // SOL requires all 4 confirmations for 5m longs
      : config.minConfirmations;

    if (config.requireTechnicalConfirmation && confirmations.score < requiredConfirmations) {
      logger?.info(
        `[ML_ADVANCED] ${symbol} LONG rejected - confirmations: ${confirmations.score}/${requiredConfirmations} ` +
        `(RSI:${confirmations.rsiOk}, MACD:${confirmations.macdOk}, VOL:${confirmations.volumeOk}, TREND:${confirmations.trendOk})`
      );
      return {
        signal: null,
        reason: `long_reject=confirmations${confirmations.score}/${requiredConfirmations}`,
      };
    }

    // Calculate stops
    const entryPrice = candles[candles.length - 1].close;
    const stopLoss = calculateStopLoss(candles, entryPrice, 'long', config.maxStopLossPercent);
    const riskAmount = entryPrice - stopLoss;
    const takeProfit = entryPrice + (riskAmount * config.riskRewardRatio);

    logger?.info(
      `[ML_ADVANCED] ${COLORS.GREEN}${symbol} LONG SIGNAL${COLORS.RESET} ` +
        `prob=${longProb.toFixed(2)} conf=${confirmations.score}/${requiredConfirmations} ` +
        `entry=${entryPrice.toFixed(4)} stop=${stopLoss.toFixed(4)} tp=${takeProfit.toFixed(4)}`,
    );

    const reasonSegments = [
      'ML_ADVANCED_LONG',
      ...summarySegments,
      `confirmations=${confirmations.score}/${requiredConfirmations}`,
    ];

    return {
      signal: {
        action: 'ENTER_LONG',
        reason: reasonSegments.join(' | '),
        stopLoss,
        takeProfit,
        confidence: longProb,
        diagnostics: {
          direction: 'long',
          timeframe: config.longTimeframe,
          probability: longProb,
          confirmations: confirmations.score,
          requiredConfirmations,
          entryPrice,
          stopLoss,
          takeProfit,
        },
        metadata: {
          strategy: 'ml_advanced',
          symbol,
          timeframe: config.longTimeframe,
          confirmations: confirmations.score,
          confirmationBreakdown: confirmations,
        },
      },
    };
  }

  private async evaluateShortSignal(params: {
    symbol: string;
    config: SymbolConfig;
    prediction?: MlProbabilityResponse;
    candles?: Candle[];
    logger?: StrategyContext['logger'];
    summarySegments: string[];
  }): Promise<DirectionEvaluation> {
    const { symbol, config, prediction, candles, logger, summarySegments } = params;
    if (!prediction || !candles?.length) {
      logger?.warn('ml_advanced_missing_short_prediction', {
        symbol,
        timeframe: config.shortTimeframe,
      });
      return {
        signal: null,
        reason: `short_reject=prediction_missing_tf=${config.shortTimeframe}`,
      };
    }

    const shortProb = prediction.short_prob;
    const shortThreshold = config.shortThreshold!;

    // Check confidence threshold
    if (shortProb < shortThreshold) {
      logger?.debug(
        `[ML_ADVANCED] ${symbol} SHORT probability ${shortProb.toFixed(2)} < threshold ${shortThreshold}`
      );
      return {
        signal: null,
        reason: `short_reject=prob${shortProb.toFixed(2)}<th${shortThreshold.toFixed(2)}`,
      };
    }

    // Technical confirmations
    const confirmations = calculateTechnicalConfirmations(candles, 'short');
    
    // BNB needs fewer confirmations (just basic check)
    const requiredConfirmations = symbol === 'BNBUSDT' 
      ? 1 
      : config.minConfirmations;

    if (config.requireTechnicalConfirmation && confirmations.score < requiredConfirmations) {
      logger?.info(
        `[ML_ADVANCED] ${symbol} SHORT rejected - confirmations: ${confirmations.score}/${requiredConfirmations} ` +
        `(RSI:${confirmations.rsiOk}, MACD:${confirmations.macdOk}, VOL:${confirmations.volumeOk}, TREND:${confirmations.trendOk})`
      );
      return {
        signal: null,
        reason: `short_reject=confirmations${confirmations.score}/${requiredConfirmations}`,
      };
    }

    // Calculate stops
    const entryPrice = candles[candles.length - 1].close;
    const stopLoss = calculateStopLoss(candles, entryPrice, 'short', config.maxStopLossPercent);
    const riskAmount = stopLoss - entryPrice;
    const takeProfit = entryPrice - (riskAmount * config.riskRewardRatio);

    logger?.info(
      `[ML_ADVANCED] ${COLORS.RED}${symbol} SHORT SIGNAL${COLORS.RESET} ` +
        `prob=${shortProb.toFixed(2)} conf=${confirmations.score}/${requiredConfirmations} ` +
        `entry=${entryPrice.toFixed(4)} stop=${stopLoss.toFixed(4)} tp=${takeProfit.toFixed(4)}`,
    );

    const reasonSegments = [
      'ML_ADVANCED_SHORT',
      ...summarySegments,
      `confirmations=${confirmations.score}/${requiredConfirmations}`,
    ];

    return {
      signal: {
        action: 'ENTER_SHORT',
        reason: reasonSegments.join(' | '),
        stopLoss,
        takeProfit,
        confidence: shortProb,
        diagnostics: {
          direction: 'short',
          timeframe: config.shortTimeframe,
          probability: shortProb,
          confirmations: confirmations.score,
          requiredConfirmations,
          entryPrice,
          stopLoss,
          takeProfit,
        },
        metadata: {
          strategy: 'ml_advanced',
          symbol,
          timeframe: config.shortTimeframe,
          confirmations: confirmations.score,
          confirmationBreakdown: confirmations,
        },
      },
    };
  }
}

// ============================================================================
// EXPORT CONFIGURATION FOR EXTERNAL USE
// ============================================================================

export function getSymbolConfig(symbol: string): SymbolConfig | null {
  return SYMBOL_CONFIGS[symbol] || null;
}

export function getSupportedSymbols(): string[] {
  return Object.keys(SYMBOL_CONFIGS);
}

export function getOptimalTimeframe(symbol: string, direction: 'long' | 'short'): string | null {
  const config = SYMBOL_CONFIGS[symbol];
  if (!config) return null;
  
  return direction === 'long' ? config.longTimeframe : config.shortTimeframe;
}
