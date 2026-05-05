import { MLService } from '../ports/MLService';
import { PhantomSignal } from '../../domain/services/PhantomStrategy';
import { AegisPredictionResponse } from '../../domain/services/AegisStrategy';
import { AegisMLServiceClient } from '../../infra/adapters/AegisMLAdapter';
import { CONFIG } from '../../infra/config/environment';

export class AegisMLService implements MLService {
  constructor(private readonly client = new AegisMLServiceClient()) {}

  async getAegisPrediction(symbol: string): Promise<AegisPredictionResponse> {
    return this.client.fetchPrediction({ symbol });
  }

  async getSignal(symbol: string): Promise<PhantomSignal> {
    const prediction = await this.getAegisPrediction(symbol);
    const longProb = prediction.long_prob ?? 0;
    const shortProb = prediction.short_prob ?? 0;
    const neutralProb = prediction.neutral_prob ?? 0;

    let action: PhantomSignal['action'] = 'PASS';
    let confidence = 0;

    if (CONFIG.TRADING_MODE === 'PHANTOM_LEGACY') {
      if (longProb > shortProb && longProb >= 0.30) {
        action = 'LONG';
        confidence = longProb;
      } else if (shortProb > longProb && shortProb >= 0.30) {
        action = 'SHORT';
        confidence = shortProb;
      }
    }

    return {
      symbol,
      action,
      confidence,
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

  async getExitSignal(payload: any): ReturnType<MLService['getExitSignal']> {
    return this.client.getExitSignal(payload);
  }

  async checkHealth(): Promise<boolean> {
    return this.client.checkHealth();
  }
}
