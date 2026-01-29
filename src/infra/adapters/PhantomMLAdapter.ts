import axios, { AxiosInstance, isAxiosError } from 'axios';
import { Candle } from '../../domain/types';

// V2 Response Type
export type MlProbabilityResponse = {
  symbol: string;
  long_prob: number;
  short_prob: number;
  neutral_prob: number;
  consensus_level: number;
  meta_verdict: string;
  // Features from ML model (for PhantomTrigger pre-filter)
  features?: {
    cvd_z?: number;
    cvd_slope?: number;
    weakness?: number;
    volatility_z?: number;
  };
  // Legacy support (optional)
  primary_timeframe?: string;
  probabilities?: Record<string, { long_prob: number; short_prob: number }>;
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
  protected readonly http: AxiosInstance;
  protected readonly baseUrl: string;

  constructor(opts: MlProbabilityClientOptions = {}) {
    // V2 Service runs on port 8001 by default
    const envBase = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001';
    this.baseUrl = (opts.baseUrl ?? envBase).replace(/\/+$/, '');

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: opts.timeoutMs ?? 30000,
    });
  }

  async fetchProbabilities(params: {
    symbol: string;
    // Legacy params (ignored in V2 but kept for interface compatibility)
    candles?: Candle[];
    timeframe?: string;
    forceRefresh?: boolean;
    extraCandles?: Record<string, Candle[]>;
  }): Promise<MlProbabilityResponse> {
    const { symbol } = params;

    // V2 Payload: Just the symbol
    const payload = { symbol };

    try {
      const { data } = await this.http.post<MlProbabilityResponse>(
        '/ml-v2/predict',
        payload,
      );

      // Adapt V2 response to look a bit like V1 if needed by consumer, 
      // or just return as is. The consumer (strategy) should be updated to use neutral_prob.
      return {
        ...data,
        primary_timeframe: '1m', // V2 works on 1m data
        probabilities: {
          '1m': { long_prob: data.long_prob, short_prob: data.short_prob }
        }
      };

    } catch (err) {
      if (isAxiosError(err)) {
        const status = err.response?.status;
        const detail = err.response?.data;
        const message =
          typeof detail === 'string'
            ? detail
            : (detail as any)?.detail?.message ||
            (detail as any)?.detail ||
            err.message ||
            'ml_service_error';
        throw new MlServiceError(message, { status, payload: detail });
      }
      throw err;
    }
  }
  async checkHealth(): Promise<boolean> {
    try {
      const { data } = await this.http.get('/health');
      return data?.status === 'healthy';
    } catch (e) {
      return false;
    }
  }
}
