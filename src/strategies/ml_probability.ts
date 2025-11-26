import { Strategy, StrategyContext } from './types';
import { Candle, Signal } from '../core/types';
import {
  MlProbabilityServiceClient,
  MlProbabilityResponse,
  MlServiceError,
} from '../ml/ml_probability_service';
import { evaluateMlFilters } from '../ml/ml_probability_filters';
import { COLORS } from '../infra/fs/FsLogger';
import { pickDirection, resolveBool, resolveExtraTimeframes } from '../ml/ml_timeframe_utils';
import { adx as adxCalc } from '../core/indicators/adx';
import { ema } from '../core/indicators/ema';

export type MlStrategyOptions = {
  timeframe?: string;
  historyBars?: number;
  serviceUrl?: string;
  timeoutMs?: number;
  client?: MlProbabilityServiceClient;
};

const DEFAULT_HISTORY_BARS = 512;

export class MlProbabilityStrategy implements Strategy {
  readonly name = 'ml_probability';
  timeframe: string;

  private readonly baseHistoryBars: number;
  private readonly client: MlProbabilityServiceClient;

  constructor(options: MlStrategyOptions = {}) {
    this.timeframe = options.timeframe ?? '5m';
    this.baseHistoryBars = Math.max(options.historyBars ?? DEFAULT_HISTORY_BARS, DEFAULT_HISTORY_BARS);
    this.client = new MlProbabilityServiceClient();
  }

  private resolveHistoryBars(config: StrategyContext['config']): number {
    const cfgValue = Number((config as any).ML_HISTORY_BARS ?? 0);
    if (Number.isFinite(cfgValue) && cfgValue > 0) {
      return Math.max(cfgValue, this.baseHistoryBars);
    }
    return this.baseHistoryBars;
  }

  private resolveTimeframe(config: StrategyContext['config']): string {
    const cfg = config as any;
    if (resolveBool(cfg.ML_USE_15M_ONLY, false)) {
      return '15m';
    }
    const tf =
      cfg.ML_MODEL_TIMEFRAME ||
      cfg.ENTRY_TIMEFRAME ||
      this.timeframe;
    return typeof tf === 'string' && tf.length ? tf : this.timeframe;
  }

  private resolveNumber(value: unknown, fallback: number): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  private formatColoredProb(value: number | null | string, color: string): string {
    if (value === null) {
      return 'n/a';
    }
    if (typeof value === 'string') {
      return `${color}${value}${COLORS.RESET}`;
    }
    return `${color}${value.toFixed(2)}${COLORS.RESET}`;
  }

  private formatTimeframeSegment(timeframe: string, longVal: number | null, shortVal: number | null): string {
    if (longVal === null || shortVal === null) return `${timeframe} long=n/a short=n/a`;

    const higher = Math.max(longVal, shortVal);
    const longColor = longVal === higher ? COLORS.CYAN : COLORS.RESET;
    const shortColor = shortVal === higher ? COLORS.CYAN : COLORS.RESET;

    const longDisplay = this.formatColoredProb(longVal, longColor);
    const shortDisplay = this.formatColoredProb(shortVal, shortColor);

    return `${timeframe} long=${longDisplay}/short=${shortDisplay}`;
  }
  private detectProbabilityConflict(primary: MlProbabilityResponse, extra?: { long_prob: number; short_prob: number }) {
    if (!primary || !extra) return null;
    const primaryDir = primary.long_prob - primary.short_prob;
    const extraDir = extra.long_prob - extra.short_prob;
    if (primaryDir === 0 || extraDir === 0) return null;
    if ((primaryDir > 0 && extraDir < 0) || (primaryDir < 0 && extraDir > 0)) {
      return { primaryDir, extraDir };
    }
    return null;
  }

  private async evaluateConflictFilter(params: {
    symbol: string;
    exchange: StrategyContext['exchange'];
    config: Record<string, unknown>;
    primaryProbs: MlProbabilityResponse;
    extraProbs?: { long_prob: number; short_prob: number };
    primaryTimeframe: string;
    extraCandles: Record<string, Candle[]>;
    logger?: StrategyContext['logger'];
  }): Promise<{ reason: string; diagnostics: Record<string, unknown> } | null> {
    const { symbol, exchange, config, primaryProbs, extraProbs, primaryTimeframe, extraCandles, logger } = params;
    const tf15 = extraCandles['15m'];
    if (!tf15 || tf15.length < 60) {
      logger?.warn('ml_conflict_tf15_missing', {
        symbol,
        available: Object.keys(extraCandles),
      });
      return null;
    }

    const closes = tf15.map((c) => c.close);
    const highs = tf15.map((c) => c.high);
    const lows = tf15.map((c) => c.low);

    const emaFastLen = Number(config.ML_CONFLICT_EMA_FAST ?? 21);
    const emaSlowLen = Number(config.ML_CONFLICT_EMA_SLOW ?? 55);
    const adxLen = Number(config.ML_CONFLICT_ADX_LEN ?? 14);
    const rsiLen = Number(config.ML_CONFLICT_RSI_LEN ?? 14);
    const adxMinTrend = Number(config.ML_CONFLICT_ADX_MIN ?? 20);
    const rsiUpper = Number(config.ML_CONFLICT_RSI_OVERBOUGHT ?? 65);
    const rsiLower = Number(config.ML_CONFLICT_RSI_OVERSOLD ?? 35);

    const emaFastValues = ema(closes, emaFastLen);
    const emaSlowValues = ema(closes, emaSlowLen);
    const emaFast = emaFastValues[emaFastValues.length - 1];
    const emaSlow = emaSlowValues[emaSlowValues.length - 1];
    const adxRaw = adxCalc(highs, lows, closes, adxLen);
    const adxLatest = adxRaw.adx;
    const conflictRsiLen = Number(config.ML_CONFLICT_RSI_LEN ?? 14);
    const gain = closes.slice(-Math.max(conflictRsiLen + 1, 2));
    let up = 0;
    let down = 0;
    for (let i = 1; i < gain.length; i++) {
      const diff = gain[i] - gain[i - 1];
      if (diff >= 0) up += diff;
      else down -= diff;
    }
    const rs = down === 0 ? Infinity : up / Math.max(down, 1e-9);
    const rsiLatest = 100 - 100 / (1 + rs);

    const primaryBias = primaryProbs.long_prob - primaryProbs.short_prob;
    const extraBias = extraProbs ? extraProbs.long_prob - extraProbs.short_prob : 0;

    const diagnostics: Record<string, unknown> = {
      emaFast,
      emaSlow,
      adxLatest,
      rsiLatest,
      primaryBias,
      extraBias,
      primaryTimeframe,
    };

    let blockReason: string | null = null;

    const trendUp = emaFast > emaSlow;
    const trendDown = emaFast < emaSlow;
    const adxStrong = adxLatest >= adxMinTrend;

    if (extraBias > 0 && trendUp && adxStrong) {
      blockReason = 'ml_conflict_block_extra_up_trend';
    } else if (extraBias < 0 && trendDown && adxStrong) {
      blockReason = 'ml_conflict_block_extra_down_trend';
    }

    if (!blockReason) {
      if (extraBias > 0 && rsiLatest !== undefined && rsiLatest > rsiUpper) {
        blockReason = 'ml_conflict_block_rsi_overbought';
      } else if (extraBias < 0 && rsiLatest !== undefined && rsiLatest < rsiLower) {
        blockReason = 'ml_conflict_block_rsi_oversold';
      }
    }

    if (!blockReason && logger) {
      logger.debug('ml_conflict_allow', {
        symbol,
        primaryBias,
        extraBias,
        emaFast,
        emaSlow,
        adxLatest,
        rsiLatest,
        adxMinTrend,
      });
    }

    if (!blockReason) {
      return null;
    }

    if (logger) {
      logger.info('ml_conflict_block', {
        symbol,
        reason: blockReason,
        primaryBias,
        extraBias,
        emaFast,
        emaSlow,
        adxLatest,
        rsiLatest,
        adxMinTrend,
      });
    }

    return {
      reason: blockReason,
      diagnostics,
    };
  }

  private buildSignal(
    requestSymbol: string,
    probs: MlProbabilityResponse,
    configMap: Record<string, unknown>,
    filters: ReturnType<typeof evaluateMlFilters>,
  ): Signal {
    const longProb = probs.long_prob;
    const shortProb = probs.short_prob;
    const diffLong = longProb - shortProb;
    const diffShort = shortProb - longProb;

    const margin = this.resolveNumber(configMap.ML_MARGIN, 0.12);
    const longThreshold = this.resolveNumber(configMap.ML_THRESHOLD_LONG, 0.5);
    const shortThreshold = this.resolveNumber(configMap.ML_THRESHOLD_SHORT, 0.5);
    const confirmMargin = this.resolveNumber(configMap.ML_CONFIRM_MARGIN, Math.max(margin * 0.5, 0.05));
    const confirmLongThreshold = this.resolveNumber(
      configMap.ML_CONFIRM_THRESHOLD_LONG,
      Math.max(longThreshold - 0.05, 0.55),
    );
    const confirmShortThreshold = this.resolveNumber(
      configMap.ML_CONFIRM_THRESHOLD_SHORT,
      Math.max(shortThreshold - 0.05, 0.55),
    );
    const primaryWeight = Math.min(Math.max(this.resolveNumber(configMap.ML_PRIMARY_WEIGHT, 0.6), 0.0), 1.0);
    const force15mOnly = resolveBool(configMap.ML_USE_15M_ONLY, false);

    const allowLongs = resolveBool(configMap.ALLOW_LONGS, true);
    const allowShorts = resolveBool(configMap.ALLOW_SHORTS, true);

    const primaryDirection = pickDirection({
      longProb,
      shortProb,
      longThreshold,
      shortThreshold,
      margin,
    });

    const extraDecisions: Array<{
      timeframe: string;
      long: number;
      short: number;
      direction: 'LONG' | 'SHORT' | null;
      gap: number;
    }> = [];

    if (!force15mOnly && probs.probabilities) {
      for (const [tf, tfProbs] of Object.entries(probs.probabilities)) {
        if (tf === probs.primary_timeframe) continue;
        const direction = pickDirection({
          longProb: tfProbs.long_prob,
          shortProb: tfProbs.short_prob,
          longThreshold: confirmLongThreshold,
          shortThreshold: confirmShortThreshold,
          margin: confirmMargin,
        });
        extraDecisions.push({
          timeframe: tf,
          long: tfProbs.long_prob,
          short: tfProbs.short_prob,
          direction,
          gap: Math.abs(tfProbs.long_prob - tfProbs.short_prob),
        });
      }
    }

    const enforceTfAlignment = force15mOnly ? false : resolveBool(configMap.ML_REQUIRE_TF_ALIGNMENT, true);
    const fifteenDecision = extraDecisions.find((entry) => entry.timeframe.toLowerCase() === '15m');
    const longProb15m = fifteenDecision?.long ?? null;
    const shortProb15m = fifteenDecision?.short ?? null;

    const alignmentPrimaryMin = this.resolveNumber(configMap.ML_ALIGNMENT_PRIMARY_MIN, 0.5);
    let primaryAlignmentDirection: 'LONG' | 'SHORT' | null = null;
    if (longProb >= alignmentPrimaryMin && longProb > shortProb) {
      primaryAlignmentDirection = 'LONG';
    } else if (shortProb >= alignmentPrimaryMin && shortProb > longProb) {
      primaryAlignmentDirection = 'SHORT';
    }

    let fifteenAlignmentDirection: 'LONG' | 'SHORT' | null = null;
    if (longProb15m !== null && shortProb15m !== null) {
      if (longProb15m > shortProb15m) {
        fifteenAlignmentDirection = 'LONG';
      } else if (shortProb15m > longProb15m) {
        fifteenAlignmentDirection = 'SHORT';
      }
    }

    const aligned =
      primaryDirection !== null &&
      extraDecisions.length > 0 &&
      extraDecisions.every((entry) => entry.direction === primaryDirection);

    const diagnostics: Record<string, unknown> = {
      longProb,
      shortProb,
      diffLong,
      diffShort,
      requestSymbol,
      serviceSymbol: probs.symbol,
      primaryTimeframe: probs.primary_timeframe,
      probabilities: probs.probabilities,
      longProb15m,
      shortProb15m,
      filterLong: filters.longReason ?? null,
      filterShort: filters.shortReason ?? null,
      emaBase: filters.emaBase,
      atr: filters.atrValue,
      rsi: filters.rsiValue,
      bodyRatio: filters.bodyRatio,
      extLong: filters.extLong,
      extShort: filters.extShort,
      primaryDirection,
      extraDecisions,
      enforceTfAlignment,
      alignmentPrimaryMin,
      primaryAlignmentDirection,
      fifteenAlignmentDirection,
      aligned,
      force15mOnly,
    };

    let tfAligned = true;
    if (enforceTfAlignment) {
      tfAligned =
        primaryAlignmentDirection !== null &&
        fifteenAlignmentDirection !== null &&
        primaryAlignmentDirection === fifteenAlignmentDirection;
    }
    diagnostics['tfAligned'] = tfAligned;

    if (!tfAligned) {
      const reasonSegments = [
        'ML_IDLE',
        'mode=tf_alignment',
        `symbol=${this.formatColoredProb(requestSymbol, COLORS.CYAN)}`,
        this.formatTimeframeSegment(probs.primary_timeframe, longProb, shortProb),
      ];
      
      // Only add 15m info if it's not already the primary timeframe
      const isPrimary15m = probs.primary_timeframe.toLowerCase() === '15m';
      if (!isPrimary15m) {
        if (fifteenDecision) {
          reasonSegments.push(
            this.formatTimeframeSegment(fifteenDecision.timeframe, fifteenDecision.long, fifteenDecision.short),
          );
        } else {
          reasonSegments.push('15m unavailable');
        }
      }
      
      return {
        action: 'IDLE',
        reason: reasonSegments.join(' | '),
        diagnostics,
      };
    }

    if (aligned) {
      if (primaryDirection === 'LONG' && allowLongs) {
        if (filters.longReason) {
          return { action: 'IDLE', reason: filters.longReason, diagnostics };
        }
        diagnostics['decision'] = 'CONSENSUS_LONG';
        const reasonSegments = [
          'ML_LONG',
          'mode=consensus',
          `symbol=${this.formatColoredProb(requestSymbol, COLORS.CYAN)}`,
          this.formatTimeframeSegment(probs.primary_timeframe, longProb, shortProb),
        ];
        extraDecisions
          .slice()
          .sort((a, b) => a.timeframe.localeCompare(b.timeframe))
          .forEach((entry) => {
            reasonSegments.push(this.formatTimeframeSegment(entry.timeframe, entry.long, entry.short));
          });
        return {
          action: 'ENTER_LONG',
          reason: reasonSegments.join(' | '),
          diagnostics,
        };
      }
      if (primaryDirection === 'SHORT' && allowShorts) {
        if (filters.shortReason) {
          return { action: 'IDLE', reason: filters.shortReason, diagnostics };
        }
        diagnostics['decision'] = 'CONSENSUS_SHORT';
        const reasonSegments = [
          'ML_SHORT',
          'mode=consensus',
          `symbol=${this.formatColoredProb(requestSymbol, COLORS.CYAN)}`,
          this.formatTimeframeSegment(probs.primary_timeframe, longProb, shortProb),
        ];
        extraDecisions
          .slice()
          .sort((a, b) => a.timeframe.localeCompare(b.timeframe))
          .forEach((entry) => {
            reasonSegments.push(this.formatTimeframeSegment(entry.timeframe, entry.long, entry.short));
          });
        return {
          action: 'ENTER_SHORT',
          reason: reasonSegments.join(' | '),
          diagnostics,
        };
      }
    }

    const effectivePrimaryWeight = extraDecisions.length === 0 ? 1 : primaryWeight;
    const extraWeight = extraDecisions.length === 0 ? 0 : (1 - effectivePrimaryWeight) / extraDecisions.length;

    let weightedScore = (longProb - shortProb) * effectivePrimaryWeight;
    for (const entry of extraDecisions) {
      weightedScore += (entry.long - entry.short) * extraWeight;
    }

    diagnostics['weightedScore'] = weightedScore;

    if (weightedScore >= margin && allowLongs) {
      if (filters.longReason) {
        return { action: 'IDLE', reason: filters.longReason, diagnostics };
      }
      diagnostics['decision'] = 'WEIGHTED_LONG';
      const reasonSegments = [
        'ML_LONG',
        'mode=weighted',
        `score=${weightedScore.toFixed(3)}`,
        `symbol=${this.formatColoredProb(requestSymbol, COLORS.CYAN)}`,
        this.formatTimeframeSegment(probs.primary_timeframe, longProb, shortProb),
      ];
      extraDecisions
        .slice()
        .sort((a, b) => a.timeframe.localeCompare(b.timeframe))
        .forEach((entry) => {
          reasonSegments.push(this.formatTimeframeSegment(entry.timeframe, entry.long, entry.short));
        });
      return {
        action: 'ENTER_LONG',
        reason: reasonSegments.join(' | '),
        diagnostics,
      };
    }

    if (weightedScore <= -margin && allowShorts) {
      if (filters.shortReason) {
        return { action: 'IDLE', reason: filters.shortReason, diagnostics };
      }
      diagnostics['decision'] = 'WEIGHTED_SHORT';
      const reasonSegments = [
        'ML_SHORT',
        'mode=weighted',
        `score=${weightedScore.toFixed(3)}`,
        `symbol=${this.formatColoredProb(requestSymbol, COLORS.CYAN)}`,
        this.formatTimeframeSegment(probs.primary_timeframe, longProb, shortProb),
      ];
      extraDecisions
        .slice()
        .sort((a, b) => a.timeframe.localeCompare(b.timeframe))
        .forEach((entry) => {
          reasonSegments.push(this.formatTimeframeSegment(entry.timeframe, entry.long, entry.short));
        });
      return {
        action: 'ENTER_SHORT',
        reason: reasonSegments.join(' | '),
        diagnostics,
      };
    }

    const idleSegments: string[] = [
      'ML_IDLE',
      `symbol=${this.formatColoredProb(requestSymbol, COLORS.CYAN)}`,
      this.formatTimeframeSegment(probs.primary_timeframe, longProb, shortProb),
    ];

    extraDecisions
      .slice()
      .sort((a, b) => a.timeframe.localeCompare(b.timeframe))
      .forEach((entry) => {
        idleSegments.push(this.formatTimeframeSegment(entry.timeframe, entry.long, entry.short));
      });

    const idleReason = idleSegments.join(' | ');

    return {
      action: 'IDLE',
      reason: idleReason,
      diagnostics,
    };
  }

  async evaluate(ctx: StrategyContext): Promise<Signal> {
    const { symbol, exchange, config, logger } = ctx;
    const timeframe = this.resolveTimeframe(config);
    const historyBars = this.resolveHistoryBars(config);

    this.timeframe = timeframe;
    const cfgMap = config as unknown as Record<string, unknown>;
    const force15mOnly = resolveBool(cfgMap.ML_USE_15M_ONLY, false);

    const candles = await exchange.getCandles(symbol, timeframe, historyBars);
    if (candles.length < historyBars) {
      logger?.debug('ml_waiting_candles', {
        symbol,
        timeframe,
        have: candles.length,
        need: historyBars,
      });
      return { action: 'IDLE', reason: 'few_candles' };
    }

    const extraTimeframes = force15mOnly
      ? []
      : resolveExtraTimeframes(
          {
            extra: cfgMap.ML_EXTRA_TIMEFRAMES,
            additional: cfgMap.ML_ADDITIONAL_TIMEFRAMES,
          },
          timeframe,
        );
    const extraCandles: Record<string, Candle[]> = {};
    const extraHistoryBars = Math.max(historyBars, 256);

    for (const extraTf of extraTimeframes) {
      try {
        const tfCandles = await exchange.getCandles(symbol, extraTf, extraHistoryBars);
        if (tfCandles.length < Math.min(extraHistoryBars, 64)) {
          logger?.debug('ml_extra_waiting_candles', {
            symbol,
            timeframe: extraTf,
            have: tfCandles.length,
            need: extraHistoryBars,
          });
          continue;
        }
        extraCandles[extraTf] = tfCandles;
      } catch (err) {
        logger?.warn('ml_extra_candles_error', {
          symbol,
          timeframe: extraTf,
          error: (err as Error)?.message ?? String(err),
        });
      }
    }

    try {
      const response = await this.client.fetchProbabilities({
        symbol,
        candles,
        timeframe,
        forceRefresh: false,
        extraCandles,
      });

      const configMap = cfgMap;
      const filterLookback = Math.min(
        candles.length,
        Math.max(this.resolveNumber(configMap.ML_FILTER_LOOKBACK, 60), 20),
      );
      const filterCandles = candles.slice(-filterLookback);
      const filters = evaluateMlFilters(filterCandles, configMap);

      if (!force15mOnly) {
        const primaryProbs = response;
        const preferredTf = (configMap.ML_CONFLICT_TF as string) || '15m';
        const primaryTf = response.primary_timeframe;
        let extraPrimary: { long_prob: number; short_prob: number } | undefined;
        if (preferredTf && response.probabilities?.[preferredTf]) {
          extraPrimary = response.probabilities[preferredTf];
        } else if (primaryTf && response.probabilities) {
          const entries = Object.entries(response.probabilities).filter(([tf]) => tf !== primaryTf);
          if (entries.length) {
            const [tf, probs] = entries.sort((a, b) => a[0].localeCompare(b[0]))[0];
            extraPrimary = probs;
          }
        }

        if (!extraPrimary && preferredTf) {
          logger?.warn?.('ml_conflict_tf_missing', {
            symbol,
            preferredTf,
            available: response.probabilities ? Object.keys(response.probabilities) : [],
          });
        }

        const conflict = this.detectProbabilityConflict(primaryProbs, extraPrimary);
        if (conflict) {
          const conflictReason = await this.evaluateConflictFilter({
            symbol,
            exchange,
            config: configMap,
            primaryProbs,
            extraProbs: extraPrimary,
            primaryTimeframe: response.primary_timeframe,
            extraCandles,
            logger,
          });
          if (conflictReason) {
            return {
              action: 'IDLE',
              reason: conflictReason.reason,
              diagnostics: {
                conflict: true,
                conflictReason: conflictReason.reason,
                primaryProbs,
                extraProbs: extraPrimary,
                techDiagnostics: conflictReason.diagnostics,
              },
            };
          }
        }
      }

      const effectiveResponse =
        force15mOnly && response.probabilities
          ? { ...response, probabilities: {} }
          : response;

      return this.buildSignal(symbol, effectiveResponse, configMap, filters);
    } catch (error) {
      if (error instanceof MlServiceError) {
        logger?.warn('ml_service_error', {
          symbol,
          status: error.status,
          message: error.message,
          detail: error.payload,
        });
        const statusLabel = error.status ?? 'error';
        return {
          action: 'IDLE',
          reason: `ml_service_${statusLabel}`,
          diagnostics: {
            error: error.message,
            status: error.status,
            detail: error.payload,
          },
        };
      }

      logger?.error('ml_service_unexpected', {
        symbol,
        err: (error as Error)?.message || String(error),
      });

      return {
        action: 'IDLE',
        reason: 'ml_service_unexpected',
      };
    }
  }
}

export const MlProbability = new MlProbabilityStrategy();
