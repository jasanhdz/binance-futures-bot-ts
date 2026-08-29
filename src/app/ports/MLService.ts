/**
 * MLService Port - Application Layer Interface
 *
 * Defines the application-facing contract for ML predictions. Infrastructure
 * adapters may return richer strategy-specific objects, but the shared port
 * must not depend on a concrete strategy implementation.
 */

export interface MLPredictionResponse {
  symbol?: string;
  long_prob?: number;
  short_prob?: number;
  neutral_prob?: number;
  close_prob?: number;
  smart_leverage?: number;
  meta_verdict?: string;
  features?: Record<string, any>;
  /** Strategy-specific diagnostic payload kept opaque at the shared boundary. */
  aegis?: any;
  [key: string]: any;
}

export interface MLTradingSignal {
  symbol: string;
  action: 'LONG' | 'SHORT' | 'PASS';
  confidence: number;
  source: 'AEGIS_SAFE' | 'AEGIS_TURBO';
  longProb: number;
  shortProb: number;
  neutralProb: number;
  closeProb?: number;
  smart_leverage?: number;
  features?: Record<string, any>;
  /** Strategy-specific diagnostic payload kept opaque at the shared boundary. */
  aegis?: any;
  metadata?: {
    aegis?: any;
    meta_verdict?: string;
    rawPrediction?: MLPredictionResponse;
    [key: string]: unknown;
  };
}

export interface MLService {
  getSignal(symbol: string): Promise<MLTradingSignal>;
  getAegisPrediction?(symbol: string): Promise<MLPredictionResponse>;
  getExitSignal(payload: {
    symbol: string;
    entry_price: number;
    current_pnl: number;
    mfe: number;
    mae: number;
    duration_minutes: number;
    leverage: number;
  }): Promise<{ action: string; confidence: number }>;
  checkHealth(): Promise<boolean>;
}
