import { Strategy, StrategyContext } from './types';
import { Candle, Signal } from '../core/types';
import {
  MlProbabilityServiceClient,
  MlProbabilityResponse,
  MlServiceError,
} from '../ml/ml_probability_service';
import { evaluateMlFilters } from '../ml/ml_probability_filters';
import { COLORS } from '../infra/fs/FsLogger';

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

  private parseTimeframeList(raw: unknown): string[] {
    const set = new Set<string>();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed) {
          set.add(trimmed);
        }
      }
    } else if (typeof raw === 'string') {
      for (const token of raw.split(/[,;]/)) {
        const trimmed = token.trim();
        if (trimmed) {
          set.add(trimmed);
        }
      }
    } else if (raw && typeof raw === 'object') {
      const value = (raw as { timeframe?: string }).timeframe;
      if (typeof value === 'string' && value.trim()) {
        set.add(value.trim());
      }
    }
    return Array.from(set);
  }

  private resolveExtraTimeframes(
    config: StrategyContext['config'],
    primaryTimeframe: string,
  ): string[] {
    const cfg = config as unknown as Record<string, unknown>;
    const defaults = ['15m'];
    const extraList = this.parseTimeframeList(cfg.ML_EXTRA_TIMEFRAMES);
    const additionalList = this.parseTimeframeList(cfg.ML_ADDITIONAL_TIMEFRAMES);
    const extras = extraList.length ? extraList : additionalList;

    const tfSet = new Set<string>();
    const primaryLower = primaryTimeframe.toLowerCase();

    for (const tf of extras ?? []) {
      if (tf.toLowerCase() === primaryLower) continue;
      tfSet.add(tf);
    }

    if (tfSet.size === 0) {
      for (const tf of defaults) {
        if (tf.toLowerCase() !== primaryLower) {
          tfSet.add(tf);
        }
      }
    }

    return Array.from(tfSet);
  }

  private resolveNumber(value: unknown, fallback: number): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  private resolveBool(value: unknown, fallback: boolean): boolean {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lowered = value.toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
      if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
    }
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return fallback;
      return value !== 0;
    }
    return fallback;
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
    const tf15m = probs.probabilities?.['15m'];
    const longProb15m = tf15m?.long_prob ?? null;
    const shortProb15m = tf15m?.short_prob ?? null;

    const margin = this.resolveNumber(configMap.ML_MARGIN, 0.12);
    const longThreshold = this.resolveNumber(configMap.ML_THRESHOLD_LONG, 0.5);
    const shortThreshold = this.resolveNumber(configMap.ML_THRESHOLD_SHORT, 0.5);
    const allowLongs = this.resolveBool(configMap.ALLOW_LONGS, true);
    const allowShorts = this.resolveBool(configMap.ALLOW_SHORTS, true);

    const diagnostics = {
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
    };

    if (allowLongs && longProb >= longThreshold && diffLong >= margin) {
      if (filters.longReason) {
        return { action: 'IDLE', reason: filters.longReason, diagnostics };
      }
      return {
        action: 'ENTER_LONG',
        reason: `${probs.symbol} ml_long p=${longProb.toFixed(2)} Δ=${diffLong.toFixed(2)} - long=${longProb.toFixed(
          2,
        )} short=${shortProb.toFixed(2)}`,
        diagnostics,
      };
    }

    if (allowShorts && shortProb >= shortThreshold && diffShort >= margin) {
      if (filters.shortReason) {
        return { action: 'IDLE', reason: filters.shortReason, diagnostics };
      }
      return {
        action: 'ENTER_SHORT',
        reason: `${probs.symbol} ml_short p=${shortProb.toFixed(2)} Δ=${diffShort.toFixed(
          2,
        )} - long=${longProb.toFixed(2)} short=${shortProb.toFixed(2)}`,
        diagnostics,
      };
    }

    const idleSegments: string[] = [
      'ML_IDLE',
      `symbol=${this.formatColoredProb(probs.symbol, COLORS.CYAN)}`,
      this.formatTimeframeSegment(probs.primary_timeframe, longProb, shortProb),
    ];

    const extraEntries = probs.probabilities
      ? Object.entries(probs.probabilities).filter(([tf]) => tf !== probs.primary_timeframe)
      : [];

    if (extraEntries.length > 0) {
      extraEntries.sort(([a], [b]) => a.localeCompare(b));
      for (const [tf, tfProbs] of extraEntries) {
        const longVal = typeof tfProbs.long_prob === 'number' ? tfProbs.long_prob : null;
        const shortVal = typeof tfProbs.short_prob === 'number' ? tfProbs.short_prob : null;
        idleSegments.push(this.formatTimeframeSegment(tf, longVal, shortVal));
      }
    } else if (longProb15m !== null || shortProb15m !== null) {
      idleSegments.push(this.formatTimeframeSegment('15m', longProb15m, shortProb15m));
    }

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

    const extraTimeframes = this.resolveExtraTimeframes(config, timeframe);
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
