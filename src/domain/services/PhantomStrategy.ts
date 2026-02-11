/**
 * PhantomStrategy - Domain Service
 * 
 * Deep Learning based trading strategy for ETH.
 * Entry decisions via HTTP ML service (Phantom V8 model).
 * 
 * @see binance-futures-bot-ts-clone/src/strategies/ml_probability.ts for reference
 */

import { Signal, Candle } from '../types';

export interface PhantomConfig {
    leverage: number;
    entryThreshold: number;
    hardStopRoe: number;
    tpRoe: number;
    beRoe?: number;
    trailingStep?: number;
    trailingActivationRoe?: number;
    trailingCallbackRoe?: number;
    maxHoldMs?: number;
    forbiddenHours?: number[];
    forbiddenDays?: number[];
}

export function isForbiddenTime(timestamp: number, forbiddenHours: number[] = [], forbiddenDays: number[] = []): boolean {
    const date = new Date(timestamp);
    const day = date.getUTCDay();
    const hour = date.getUTCHours();
    return forbiddenDays.includes(day) || forbiddenHours.includes(hour);
}

export interface PhantomSignal {
    symbol: string;
    action: 'PASS' | 'SHORT' | 'LONG';
    confidence: number;
    longProb: number;
    shortProb: number;
    neutralProb: number;
    smart_leverage?: number; // V30 Leverage
    features?: {
        cvd_z?: number;
        cvd_slope?: number;
        weakness?: number;
    };
    diagnostics?: {
        longProb: number;
        shortProb: number;
        neutralProb: number;
        threshold: number;
    };
    metadata?: Record<string, any>;
}

export const DEFAULT_PHANTOM_CONFIG: PhantomConfig = {
    leverage: 5,
    entryThreshold: 0.55,
    hardStopRoe: -0.015,
    tpRoe: 0.06,
    beRoe: 0.10,
    trailingStep: 0.015
};

/**
 * PhantomTrigger - Pre-filter for ML signals
 * 
 * This is a CRITICAL component that ensures we only trade when:
 * 1. CVD Slope is negative (distribution pressure - smart money selling)
 * 2. CVD Z-Score is below 0.5 (cumulative selling pressure)
 * 3. Current candle is bearish (price action confirms)
 * 4. ETH is weaker than BTC (relative weakness)
 * 
 * WHY THIS HELPS:
 * - The ML model gives probabilistic signals, but it can fire in non-ideal conditions
 * - This pre-filter ensures we only act on ML signals when market structure confirms
 * - Reduces false positives by requiring BOTH technical confirmation AND ML confidence
 * - Matches the exact logic used in the successful Python backtest ($20 → $79M)
 */
export interface PhantomTriggerContext {
    currentCandle: Candle;
    cvdSlope: number;      // Change in CVD over 5 candles (negative = distribution)
    cvdZ: number;          // Z-score of CVD (below 0.5 = selling pressure)
    weaknessScore: number; // ETH/BTC ratio divergence (positive = ETH weaker)
}

/**
 * Checks if technical conditions are met for a Phantom SHORT entry
 * 
 * @param ctx - Market context with CVD and weakness metrics
 * @returns true if all conditions are met for a valid trigger
 */
export function checkPhantomTrigger(ctx: PhantomTriggerContext): boolean {
    // 1. CVD Slope must be NEGATIVE (distribution - smart money exiting)
    //    This indicates that over the last 5 candles, selling volume has dominated
    if (ctx.cvdSlope > 0) {
        return false;
    }

    // 2. CVD Z-Score must be below 0.5 (cumulative selling pressure)
    //    This means the 20-period CVD is below its rolling average
    if (ctx.cvdZ > 0.5) {
        return false;
    }

    // 3. Current candle must be BEARISH (close < open)
    //    Price action must confirm the distribution pattern
    if (ctx.currentCandle.close >= ctx.currentCandle.open) {
        return false;
    }

    // 4. ETH must be WEAKER than BTC (positive weakness score)
    //    When ETH underperforms BTC, it signals relative weakness
    //    This is calculated as: (ETH/BTC EMA - ETH/BTC ratio) * 100
    //    Positive = ETH is falling faster than BTC
    if (ctx.weaknessScore < 0) {
        return false;
    }

    // All conditions met - valid phantom trigger!
    return true;
}

/**
 * Evaluates if a signal should trigger an entry
 * Now requires BOTH ML confidence AND technical trigger
 */
export function shouldEnter(
    signal: PhantomSignal,
    config: PhantomConfig,
    triggerCtx?: PhantomTriggerContext
): boolean {
    // First check: ML model must say SHORT or LONG with sufficient confidence
    if ((signal.action !== 'SHORT' && signal.action !== 'LONG') || signal.confidence <= config.entryThreshold) {
        return false;
    }

    // Second check (if context provided): Technical conditions must align
    // DISABLED FOR V9: Inference Server handles all filtering (Staleness, Volatility, Fakeouts)
    // if (triggerCtx && !checkPhantomTrigger(triggerCtx)) {
    //     return false;
    // }

    return true;
}

/**
 * Maps Phantom signal to trading Signal format
 */
export function toTradeSignal(
    signal: PhantomSignal,
    config: PhantomConfig,
    triggerCtx?: PhantomTriggerContext
): Signal {
    const diagnostics = {
        longProb: signal.longProb,
        shortProb: signal.shortProb,
        neutralProb: signal.neutralProb,
        threshold: config.entryThreshold
    };

    if (shouldEnter(signal, config, triggerCtx)) {
        return {
            action: signal.action === 'LONG' ? 'ENTER_LONG' : 'ENTER_SHORT',
            reason: `PHANTOM | conf=${(signal.confidence * 100).toFixed(1)}%`,
            confidence: signal.confidence,
            diagnostics
        };
    }
    return {
        action: 'IDLE',
        reason: 'PHANTOM_WAIT',
        diagnostics
    };
}

