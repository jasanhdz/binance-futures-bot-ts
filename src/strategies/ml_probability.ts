import { Strategy, StrategyContext } from './types';
import { Signal } from '../core/types';
import {
  MlProbabilityServiceClient,
  MlProbabilityResponse,
  MlServiceError,
} from '../ml/ml_probability_service';
import { evaluateMlFilters } from '../ml/ml_probability_filters';

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
    const allowLongs = this.resolveBool(configMap.ALLOW_LONGS, true);
    const allowShorts = this.resolveBool(configMap.ALLOW_SHORTS, true);

    const diagnostics = {
      longProb,
      shortProb,
      diffLong,
      diffShort,
      serviceSymbol: probs.symbol,
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

    return {
      action: 'IDLE',
      reason: `symbol:${probs.symbol} ml_idle long=${longProb.toFixed(2)} short=${shortProb.toFixed(2)}`,
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

    try {
      const response = await this.client.fetchProbabilities({
        symbol,
        candles,
        timeframe,
        forceRefresh: false,
      });

      const configMap = config as unknown as Record<string, unknown>;
      const filterLookback = Math.min(
        candles.length,
        Math.max(this.resolveNumber(configMap.ML_FILTER_LOOKBACK, 60), 20),
      );
      const filterCandles = candles.slice(-filterLookback);
      const filters = evaluateMlFilters(filterCandles, configMap);

      logger?.debug('ml_service_probs', {
        symbol,
        timeframe,
        longProb: response.long_prob,
        shortProb: response.short_prob,
        filters,
      });

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
