import { Strategy, StrategyContext } from './types';
import { Candle, Signal } from '../core/types';
import {
  MlProbabilityServiceClient,
  MlProbabilityResponse,
  MlServiceError,
} from '../ml/ml_probability_service';
import { COLORS } from '../infra/fs/FsLogger';
import { MlConfigWatcher } from '../config/MlConfigWatcher';

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
  private readonly configWatcher: MlConfigWatcher;

  constructor(options: MlStrategyOptions = {}) {
    this.timeframe = options.timeframe ?? '1h';
    this.baseHistoryBars = Math.max(options.historyBars ?? DEFAULT_HISTORY_BARS, DEFAULT_HISTORY_BARS);
    this.client = new MlProbabilityServiceClient();
    this.configWatcher = MlConfigWatcher.getInstance();
  }

  private resolveHistoryBars(config: StrategyContext['config']): number {
    const cfgValue = Number((config as any).ML_HISTORY_BARS ?? 0);
    if (Number.isFinite(cfgValue) && cfgValue > 0) {
      return Math.max(cfgValue, this.baseHistoryBars);
    }
    return this.baseHistoryBars;
  }

  private resolveTimeframe(config: StrategyContext['config'], symbol: string): string {
    const tf = (config as any).SYMBOL_TIMEFRAMES?.[symbol] || (config as any).ML_MODEL_TIMEFRAME || (config as any).ENTRY_TIMEFRAME || this.timeframe;
    return typeof tf === 'string' && tf.length ? tf : this.timeframe;
  }

  private formatIdleReason(symbol: string, timeframe: string, longProb: number, shortProb: number, threshold: number): string {
    // Columnar alignment so the '|' stays at the same spot; pad raw text before coloring.
    const SYMBOL_COL = 8; // Longest we expect (e.g., LINKUSDT = 8)
    const TF_COL = 3; // e.g., 1h, 4h, 15m
    const paddedSymbol = symbol.padEnd(SYMBOL_COL, ' ');
    const paddedTf = timeframe.padEnd(TF_COL, ' ');
    const coloredSymbol = `${COLORS.CYAN}${paddedSymbol}${COLORS.RESET}`;
    const coloredTf = `${COLORS.CYAN}${paddedTf}${COLORS.RESET}`;
    const th = Number.isFinite(threshold) ? (threshold as number).toFixed(2) : String(threshold);
    return `${coloredSymbol} ${coloredTf} | ML_IDLE | (L=${longProb.toFixed(2)} | S=${shortProb.toFixed(2)}) < t=${th}`;
  }

  private formatColoredProb(value: number | null, color: string): string {
    if (value === null) return 'n/a';
    return `${color}${value.toFixed(2)}${COLORS.RESET}`;
  }

  async evaluate(ctx: StrategyContext): Promise<Signal> {
    const { symbol, exchange, config, logger } = ctx;
    const timeframe = this.resolveTimeframe(config, symbol);
    const historyBars = this.resolveHistoryBars(config);

    // 1. Get Candles
    const candles = await exchange.getCandles(symbol, timeframe, historyBars);
    if (candles.length < Math.min(historyBars, 200)) {
      logger?.debug('ml_waiting_candles', { symbol, timeframe, have: candles.length, need: historyBars });
      return { action: 'IDLE', reason: 'few_candles' };
    }

    try {
      // 2. Call ML Service
      const response = await this.client.fetchProbabilities({
        symbol,
        candles,
        timeframe,
        forceRefresh: false,
        extraCandles: {}, // We don't need extra candles for single-model inference anymore
      });

      // 3. Get Dynamic Threshold
      const threshold = this.configWatcher.getThreshold(symbol, timeframe);
      
      const longProb = response.long_prob;
      const shortProb = response.short_prob;
      
      const diagnostics = {
        symbol,
        timeframe,
        longProb,
        shortProb,
        threshold,
        pnl_config: this.configWatcher.getConfig(symbol, timeframe)?.pnl
      };

      // 4. Decision Logic (Pure ML)
      if (longProb > threshold) {
        return {
          action: 'ENTER_LONG',
          reason: `ML_LONG | p=${this.formatColoredProb(longProb, COLORS.GREEN)} > t=${threshold}`,
          diagnostics
        };
      }

      if (shortProb > threshold) {
        return {
          action: 'ENTER_SHORT',
          reason: `ML_SHORT | p=${this.formatColoredProb(shortProb, COLORS.RED)} > t=${threshold}`,
          diagnostics
        };
      }

      return {
        action: 'IDLE',
        reason: this.formatIdleReason(symbol, timeframe, longProb, shortProb, threshold),
        diagnostics
      };

    } catch (error) {
      if (error instanceof MlServiceError) {
        // If model not found (404), log warning but don't crash
        if (error.status === 404) {
             logger?.warn('ml_model_missing', { symbol, timeframe });
             return { action: 'IDLE', reason: 'model_missing' };
        }
        logger?.warn('ml_service_error', { symbol, error: error.message });
        return { action: 'IDLE', reason: 'ml_service_error' };
      }
      
      logger?.error('ml_unexpected_error', { symbol, error: String(error) });
      return { action: 'IDLE', reason: 'ml_unexpected' };
    }
  }
}

export const MlProbability = new MlProbabilityStrategy();
