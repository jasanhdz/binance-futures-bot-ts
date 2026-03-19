/**
 * MLService Port - Application Layer Interface
 * 
 * Defines the contract for ML prediction service.
 * Implemented by PhantomMLAdapter in infrastructure layer.
 */

import { PhantomSignal } from '../../domain/services/PhantomStrategy';

export interface MLService {
    getSignal(symbol: string): Promise<PhantomSignal>;
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
