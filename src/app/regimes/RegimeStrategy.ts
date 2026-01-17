/**
 * RegimeStrategy Interface
 * Base contract for all trading regime strategies in Ninja System v5.0
 */

export type RegimeType = 'BLOODBATH' | 'WHALE' | 'MONK' | 'BUNKER' | 'BERZERKER';
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
    maxHoldMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// NINJA v5.1: CONTEXTO COMPLETO PARA DECISIONES DE SALIDA
// ═══════════════════════════════════════════════════════════════════════════
export interface ExitContext {
    currentRoe: number;       // ROE actual (decimal, ej. 0.05 = 5%)
    peakRoe: number;          // Pico máximo ROE alcanzado
    holdTimeMs: number;       // Tiempo en posición (ms)
    opposingProb: number;     // Probabilidad del lado OPUESTO (0-1)
    neutralProb: number;      // Probabilidad de Neutral (0-1)
    volatilityFactor: number; // Factor de volatilidad (spread actual / spread promedio)
    // v5.1: Added for Universal Profit Guardian
    marketBias: MarketBias;   // Current ML bias (BULL/BEAR/NEUTRAL)
    positionSide: 'LONG' | 'SHORT'; // Current position side
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
     * NINJA v5.0: Evaluates exit conditions with full market context
     * Replaces getExitReason() - each regime decides its own panic/neutrality behavior
     * @returns Exit reason string or null if should hold
     */
    evaluateExit(ctx: ExitContext, symbol?: string): string | null;
}
