/**
 * NINJA v5.1: Universal Dynamic Profit Guardian
 * 
 * Centralizes profit protection logic to avoid "Fee Churning".
 * 
 * Features:
 * - Peak Threshold (>1%) to avoid triggering on noise
 * - Dynamic Drawdown adjusted by Volatility
 * - ML Trend Filter (Don't close if market still favors position)
 */

export interface GuardianContext {
    peakRoe: number;          // Peak ROE (0.20 = 20%)
    currentRoe: number;       // Current ROE (-0.05 = -5%)
    volatilityFactor: number; // 1.0 = Normal, 2.0 = Very volatile
    marketBias: 'BULL' | 'BEAR' | 'NEUTRAL';
    positionSide: 'LONG' | 'SHORT';
}

export interface GuardianConfig {
    peakThreshold: number;       // Min peak to activate (0.01 = 1%)
    baseDrawdown: number;        // Base allowed drawdown (0.30 = 30%)
    volatilitySensitivity: number; // 0.0 to 1.0
    enableTrendProtection: boolean;
}

export class UniversalProfitGuardian {
    private config: GuardianConfig;

    constructor(config: GuardianConfig) {
        this.config = config;
    }

    /**
     * Evaluates if position should close to secure profits.
     * @returns TRUE if should lock profits (close).
     */
    evaluate(ctx: GuardianContext): boolean {
        // 1. ANTI-NOISE: If peak below threshold, don't act
        if (ctx.peakRoe < this.config.peakThreshold) {
            return false;
        }

        // 2. CALCULATE DRAWDOWN (Fall from peak)
        const drawdown = ctx.peakRoe - ctx.currentRoe;

        // 3. DYNAMIC LIMIT BASED ON VOLATILITY
        let volMultiplier = 1.0;
        if (ctx.volatilityFactor >= 1.5) {
            volMultiplier = 1.0 - (this.config.volatilitySensitivity * 0.5);
        } else if (ctx.volatilityFactor <= 0.8) {
            volMultiplier = 1.0 + (this.config.volatilitySensitivity * 0.5);
        }
        volMultiplier = Math.max(0.5, Math.min(1.5, volMultiplier));

        const allowedDrawdown = this.config.baseDrawdown * volMultiplier;

        // 4. CHECK IF EXCEEDS LIMIT
        if (drawdown >= allowedDrawdown) {
            // 5. ML TREND FILTER
            if (this.config.enableTrendProtection) {
                const biasFavorsMe =
                    (ctx.positionSide === 'LONG' && ctx.marketBias === 'BULL') ||
                    (ctx.positionSide === 'SHORT' && ctx.marketBias === 'BEAR');

                if (biasFavorsMe) {
                    return false; // HOLD: Trend still alive
                }
            }
            return true; // CLOSE: Secure profit
        }

        return false; // HOLD
    }

    // Predefined configs per regime
    static WHALE_CONFIG: GuardianConfig = {
        peakThreshold: 0.015,      // Activate only with >1.5% gain
        baseDrawdown: 0.40,        // Allow 40% drawdown from peak
        volatilitySensitivity: 0.20,
        enableTrendProtection: true
    };

    static MONK_CONFIG: GuardianConfig = {
        peakThreshold: 0.01,       // Activate with >1%
        baseDrawdown: 0.25,        // Allow 25% drawdown (ranges are small)
        volatilitySensitivity: 0.30,
        enableTrendProtection: true
    };

    static BLOODBATH_CONFIG: GuardianConfig = {
        peakThreshold: 0.005,      // Activate with >0.5%
        baseDrawdown: 0.15,        // Chaos = exit fast (15%)
        volatilitySensitivity: 0.50,
        enableTrendProtection: false // In chaos, don't trust ML
    };
}
