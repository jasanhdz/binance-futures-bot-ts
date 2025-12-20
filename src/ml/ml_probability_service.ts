import axios, { AxiosInstance, isAxiosError } from 'axios';
import { Candle } from '../core/types';

export type CandlePayload = {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  close_time: number;
};

export type TimeframeProbability = {
  long_prob: number;
  short_prob: number;
};

export type MlProbabilityResponse = {
  symbol: string;
  primary_timeframe: string;
  long_prob: number;
  short_prob: number;
  probabilities: Record<string, TimeframeProbability>;
};

export type MlProbabilityClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
};

export class MlServiceError extends Error {
  readonly status?: number;
  readonly payload?: unknown;

  constructor(message: string, opts: { status?: number; payload?: unknown } = {}) {
    super(message);
    this.name = 'MlServiceError';
    this.status = opts.status;
    this.payload = opts.payload;
  }
}

export class MlProbabilityServiceClient {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(opts: MlProbabilityClientOptions = {}) {
    const envBase = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000';
    this.baseUrl = (opts.baseUrl ?? envBase).replace(/\/+$/, '');

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: opts.timeoutMs ?? 10000,
    });
  }

  /**
   * Convert bot candle objects into the payload required by the Python service.
   */
  private toPayload(candles: Candle[]): CandlePayload[] {
    return candles
      .slice()
      .sort((a, b) => a.closeTime - b.closeTime)
      .map((c) => ({
        open_time: Math.trunc(c.openTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        close_time: Math.trunc(c.closeTime),
      }));
  }

  async fetchProbabilities(params: {
    symbol: string;
    candles: Candle[];
    timeframe?: string;
    forceRefresh?: boolean;
    extraCandles?: Record<string, Candle[]>;
  }): Promise<MlProbabilityResponse> {
    const { symbol, candles, timeframe, forceRefresh, extraCandles } = params;
    const payload: Record<string, unknown> = {
      symbol,
      timeframe,
      force_refresh: forceRefresh ?? false,
      candles: this.toPayload(candles),
    };

    if (extraCandles && Object.keys(extraCandles).length > 0) {
      const prepared: Record<string, CandlePayload[]> = {};
      for (const [tf, tfCandles] of Object.entries(extraCandles)) {
        if (!tfCandles?.length) continue;
        prepared[tf] = this.toPayload(tfCandles);
      }
      if (Object.keys(prepared).length > 0) {
        payload.extra_candles = prepared;
      }
    }

    try {
      const { data } = await this.http.post<MlProbabilityResponse>(
        '/ml/probabilities',
        payload,
      );
      return data;
    } catch (err) {
      if (isAxiosError(err)) {
        const status = err.response?.status;
        const detail = err.response?.data;
        const message =
          typeof detail === 'string'
            ? detail
            : detail?.detail?.message ||
              detail?.detail ||
              err.message ||
              'ml_service_error';
        throw new MlServiceError(message, { status, payload: detail });
      }
      throw err;
    }
  }
}
