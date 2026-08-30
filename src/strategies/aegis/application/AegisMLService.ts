import type { MLService } from '../../../app/ports/MLService';
import type { AegisPredictionResponse, AegisTradingSignal } from '../domain/AegisStrategy';
import { AegisMLServiceClient } from '../../../infra/adapters/AegisMLAdapter';
import type { AegisMarketContextV1 } from './AegisMarketContext';

/** Aegis-specific ML application service. Not part of the generic bot bootstrap contract. */
export class AegisMLService implements MLService {
  constructor(private readonly client = new AegisMLServiceClient()) {}

  async getAegisPrediction(
    symbol: string,
    context?: AegisMarketContextV1,
  ): Promise<AegisPredictionResponse> {
    return this.client.fetchPrediction({ symbol, marketContext: context });
  }

  async getSignal(symbol: string, context?: unknown): Promise<AegisTradingSignal> {
    const marketContext = context as AegisMarketContextV1 | undefined;
    const prediction = await this.getAegisPrediction(symbol, marketContext);
    const longProb = prediction.long_prob ?? 0;
    const shortProb = prediction.short_prob ?? 0;
    const neutralProb = prediction.neutral_prob ?? 0;

    return {
      symbol,
      action: 'PASS',
      confidence: 0,
      source: 'AEGIS_SAFE',
      longProb,
      shortProb,
      neutralProb,
      closeProb: prediction.close_prob,
      smart_leverage: prediction.smart_leverage,
      features: prediction.features,
      metadata: {
        aegis: prediction.aegis,
        meta_verdict: prediction.meta_verdict,
        rawPrediction: prediction,
      },
    };
  }

  async getExitSignal(payload: unknown): ReturnType<MLService['getExitSignal']> {
    return this.client.getExitSignal(payload);
  }

  async checkHealth(): Promise<boolean> {
    return this.client.checkHealth();
  }
}
