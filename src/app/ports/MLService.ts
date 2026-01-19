/**
 * MLService Port - Application Layer Interface
 * 
 * Defines the contract for ML prediction service.
 * Implemented by PhantomMLAdapter in infrastructure layer.
 */

import { PhantomSignal } from '../../domain/services/PhantomStrategy';

export interface MLService {
    getSignal(symbol: string): Promise<PhantomSignal>;
    checkHealth(): Promise<boolean>;
}
