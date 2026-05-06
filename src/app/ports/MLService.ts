/**
 * MLService Port - Application Layer Interface
 * 
 * Defines the contract for ML prediction service.
 * Implemented by AegisMLAdapter in infrastructure layer.
 */

import { AegisPredictionResponse, AegisTradingSignal } from '../../domain/services/AegisStrategy';

export interface MLService {
    getSignal(symbol: string): Promise<AegisTradingSignal>;
    getAegisPrediction?(symbol: string): Promise<AegisPredictionResponse>;
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
