import axios, { AxiosInstance } from 'axios';
import { MLService } from '../../app/ports/MLService';
import { AegisPredictionResponse } from '../../domain/services/AegisStrategy';
import { CONFIG } from '../config/environment';

export class AegisMLServiceClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: CONFIG.ML_SERVICE_URL.replace(/\/+$/, ''),
      timeout: 5000,
    });
  }

  async fetchPrediction(payload: { symbol: string }): Promise<AegisPredictionResponse> {
    const { data } = await this.http.post<AegisPredictionResponse>('/ml-v2/predict', {
      symbol: payload.symbol,
    });
    return data;
  }

  async getExitSignal(payload: any): ReturnType<MLService['getExitSignal']> {
    try {
      const { data } = await this.http.post<{ action: string; confidence: number }>(
        '/ml-v2/exit_signal',
        payload,
      );
      return {
        action: data.action,
        confidence: data.confidence,
      };
    } catch {
      return { action: 'HOLD', confidence: 0 };
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await this.http.get('/health');
      return response.status === 200;
    } catch {
      return false;
    }
  }
}
