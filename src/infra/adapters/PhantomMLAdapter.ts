import axios, { AxiosInstance, isAxiosError } from 'axios';
import { Candle } from '../../domain/types';

// V2 Response Type
export type MlProbabilityResponse = {
  symbol: string;
  long_prob: number;
  short_prob: number;
  neutral_prob: number;
  close_prob?: number;
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
  smart_leverage?: number; // New V30 field
};

export type MlProbabilityClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
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
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(opts: MlProbabilityClientOptions = {}) {
    // V2 Service runs on port 8001 by default
    const envBase = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001';
    this.baseUrl = (opts.baseUrl ?? envBase).replace(/\/+$/, '');
    this.retries = opts.retries ?? Number(process.env.ML_SERVICE_RETRIES ?? 3);
    this.retryDelayMs = opts.retryDelayMs ?? Number(process.env.ML_SERVICE_RETRY_DELAY_MS ?? 750);

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: opts.timeoutMs ?? 30000,
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isTransientMlError(err: unknown): boolean {
    if (!isAxiosError(err)) {
      return false;
    }
    if (err.response) {
      return err.response.status === 502 || err.response.status === 503 || err.response.status === 504;
    }
    return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code ?? '');
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

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
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
        if (attempt < this.retries && this.isTransientMlError(err)) {
          await this.sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
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

    throw new MlServiceError('ml_service_retry_exhausted');
  }

  async getExitSignal(params: {
    symbol: string;
    entry_price: number;
    current_pnl: number;
    mfe: number;
    mae: number;
    duration_minutes: number;
    leverage: number;
  }): Promise<{ action: string; confidence: number }> {
    try {
      const { data } = await this.http.post<{ action: string; confidence: number }>(
        '/ml-v2/exit_signal',
        params,
      );
      return {
        action: data.action,
        confidence: data.confidence,
      };
    } catch (err) {
      if (isAxiosError(err)) {
        console.error('MlServiceError (Exit Signal):', err.message);
      }
      // Fallback
      return { action: 'HOLD', confidence: 0.0 };
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
