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
    const tf =
      (config as any).ML_MODEL_TIMEFRAME ||
      (config as any).ENTRY_TIMEFRAME ||
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

  private buildSignal(
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

    if (probs.probabilities) {
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

    const aligned =
      primaryDirection !== null &&
      extraDecisions.length > 0 &&
      extraDecisions.every((entry) => entry.direction === primaryDirection);

    const firstExtra = extraDecisions.find((entry) => entry.timeframe.toLowerCase() === '15m');
    const longProb15m = firstExtra?.long ?? null;
    const shortProb15m = firstExtra?.short ?? null;

    const diagnostics: Record<string, unknown> = {
      longProb,
      shortProb,
      diffLong,
      diffShort,
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
      aligned,
    };

    if (aligned) {
      if (primaryDirection === 'LONG' && allowLongs) {
        if (filters.longReason) {
          return { action: 'IDLE', reason: filters.longReason, diagnostics };
        }
        diagnostics['decision'] = 'CONSENSUS_LONG';
        const reasonSegments = [
          'ML_LONG',
          'mode=consensus',
          `symbol=${this.formatColoredProb(probs.symbol, COLORS.CYAN)}`,
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
          `symbol=${this.formatColoredProb(probs.symbol, COLORS.CYAN)}`,
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
        `symbol=${this.formatColoredProb(probs.symbol, COLORS.CYAN)}`,
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
        `symbol=${this.formatColoredProb(probs.symbol, COLORS.CYAN)}`,
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
      `symbol=${this.formatColoredProb(probs.symbol, COLORS.CYAN)}`,
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

    const cfgMap = config as unknown as Record<string, unknown>;
    const extraTimeframes = resolveExtraTimeframes(
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

      const configMap = config as unknown as Record<string, unknown>;
      const filterLookback = Math.min(
        candles.length,
        Math.max(this.resolveNumber(configMap.ML_FILTER_LOOKBACK, 60), 20),
      );
      const filterCandles = candles.slice(-filterLookback);
      const filters = evaluateMlFilters(filterCandles, configMap);

      return this.buildSignal(response, configMap, filters);
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
