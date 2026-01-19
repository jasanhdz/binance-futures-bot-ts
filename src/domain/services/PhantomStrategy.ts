/**
 * PhantomStrategy - Domain Service
 * 
 * Deep Learning based trading strategy for ETH.
 * Entry decisions via HTTP ML service (Phantom V8 model).
 * 
 * @see binance-futures-bot-ts-clone/src/strategies/ml_probability.ts for reference
 */

import { Signal } from '../types';

export interface PhantomConfig {
    leverage: number;
    entryThreshold: number;
    hardStopRoe: number;
    tpRoe: number;
    beRoe?: number;
    trailingStep?: number;
}

export interface PhantomSignal {
    symbol: string;
    action: 'PASS' | 'SHORT';
    confidence: number;
    longProb: number;
    shortProb: number;
    neutralProb: number;
}

export const DEFAULT_PHANTOM_CONFIG: PhantomConfig = {
    leverage: 3,
    entryThreshold: 0.55,
    hardStopRoe: -0.015,
    tpRoe: 0.06,
    beRoe: 0.10,
    trailingStep: 0.015
};

/**
 * Evaluates if a signal should trigger an entry
 */
export function shouldEnter(signal: PhantomSignal, config: PhantomConfig): boolean {
    return signal.action === 'SHORT' && signal.confidence > config.entryThreshold;
}

/**
 * Maps Phantom signal to trading Signal format
 */
export function toTradeSignal(signal: PhantomSignal, config: PhantomConfig): Signal {
    if (shouldEnter(signal, config)) {
        return {
            action: 'ENTER_SHORT',
            reason: `PHANTOM | conf=${(signal.confidence * 100).toFixed(1)}%`,
            confidence: signal.confidence
        };
    }
    return { action: 'IDLE', reason: 'PHANTOM_WAIT' };
}
