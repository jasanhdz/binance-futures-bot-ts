/**
 * RegimeStrategy Interface
 * Base contract for all trading regime strategies in Ninja System v3.0
 */

export type RegimeType = 'BLOODBATH' | 'WHALE' | 'MONK' | 'BUNKER';
export type VolatilityLevel = 'LOW' | 'MED' | 'HIGH';
export type MarketBias = 'BULL' | 'BEAR' | 'NEUTRAL';
export type ConfidenceLevel = 'LOW' | 'MED' | 'HIGH';

export interface RegimeContext {
    type: RegimeType;
    confidence: ConfidenceLevel;
    volatility: VolatilityLevel;
    bias: MarketBias;
    trigger: string;
}

export interface RegimeConfig {
    leverage: number;
    hardStopRoe: number;  // Negative number (e.g., -0.015 = -1.5%)
    tpRoe: number;        // Positive number (e.g., 0.02 = +2%)
    entryThreshold: number; // ML probability threshold
    trailingActivationRoe?: number;
    maxHoldMs?: number;
}

export interface IRegimeStrategy {
    readonly name: RegimeType;

    /**
     * Returns the configuration for this regime (with optional symbol-level overrides)
     */
    getConfig(symbol?: string): RegimeConfig;

    /**
     * Determines if the strategy should enter a position
     */
    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean;

    /**
     * Evaluates exit conditions
     * @returns Exit reason string or null if should hold
     */
    getExitReason(currentRoe: number, peakRoe: number, holdTimeMs: number, symbol?: string): string | null;
}
