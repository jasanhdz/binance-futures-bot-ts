/**
 * Regime Detector v2.0
 * 
 * The "Brain" of Ninja System v3.0
 * Analyzes market micro-state to determine which Regime is active.
 */

import {
    RegimeType,
    RegimeContext,
    VolatilityLevel,
    MarketBias,
    ConfidenceLevel
} from '../regimes/RegimeStrategy';
import { getNinjaConfig } from './NinjaConfigManager';

export interface MarketSnapshot {
    spreadPct: number;        // From orderbook
    obi: number;              // Order Book Imbalance
    fundingRate: number;      // Funding Rate
    longProb: number;         // ML Long probability
    shortProb: number;        // ML Short probability
    neutralProb: number;      // ML Neutral probability
}

export class RegimeDetector {
    private lastRegime: RegimeType = 'BUNKER';
    private regimeStickyCounter: number = 0;
    private readonly REGIME_STICKY_THRESHOLD = 3; // Ticks to confirm regime change

    /**
     * Analyzes market data to determine the active trading regime.
     * Implements hysteresis to prevent regime flickering.
     */
    analyze(snapshot: MarketSnapshot): RegimeContext {
        // Hot-reload config if changed
        getNinjaConfig().reloadIfNeeded();

        // 1. Calculate Volatility Level (from spread)
        const volatility = this.classifyVolatility(snapshot.spreadPct);

        // 2. Calculate Market Bias (from ML probabilities)
        const bias = this.classifyBias(snapshot.longProb, snapshot.shortProb);

        // 3. Determine Raw Regime
        const rawRegime = this.detectRawRegime(snapshot, volatility, bias);

        // 4. Apply Hysteresis (Sticky Regime)
        const finalRegime = this.applyHysteresis(rawRegime);

        // 5. Build Context
        return {
            type: finalRegime,
            confidence: this.calculateConfidence(snapshot, finalRegime),
            volatility,
            bias,
            trigger: this.getTriggerReason(finalRegime, snapshot)
        };
    }

    private classifyVolatility(spreadPct: number): VolatilityLevel {
        // Read thresholds from config
        const config = getNinjaConfig().regimeDetector;

        if (spreadPct > config.volatility_spread_high) return 'HIGH';
        if (spreadPct > config.volatility_spread_low) return 'MED';
        return 'LOW';
    }

    private classifyBias(longProb: number, shortProb: number): MarketBias {
        const config = getNinjaConfig().regimeDetector;
        const diff = longProb - shortProb;

        if (diff > config.bias_strength_threshold) return 'BULL';
        if (diff < -config.bias_strength_threshold) return 'BEAR';
        return 'NEUTRAL';
    }

    private detectRawRegime(
        snapshot: MarketSnapshot,
        volatility: VolatilityLevel,
        bias: MarketBias
    ): RegimeType {
        const { neutralProb, fundingRate, obi } = snapshot;

        // ═══════════════════════════════════════════════════════════
        // REGIME DETECTION LOGIC (Priority Order)
        // ═══════════════════════════════════════════════════════════

        // CASE 1: BLOODBATH (Panic / Wick Hunting)
        // High volatility + ML confusion (high neutral) = market chaos
        if (volatility === 'HIGH' && neutralProb > 0.50) {
            return 'BLOODBATH';
        }

        // CASE 2: WHALE (Strong Trend)
        // Medium volatility + Strong bias + Funding aligned
        if (volatility === 'MED' && bias !== 'NEUTRAL') {
            // Check funding alignment with bias
            const fundingAligned =
                (bias === 'BULL' && fundingRate > 0) ||
                (bias === 'BEAR' && fundingRate < 0);

            // OBI should also confirm direction
            const obiAligned =
                (bias === 'BULL' && obi > 0.1) ||
                (bias === 'BEAR' && obi < -0.1);

            if (fundingAligned || obiAligned) {
                return 'WHALE';
            }
        }

        // CASE 3: MONK (Sweet Spot / Range)
        // Low volatility + Neutral bias = boring range
        if (volatility === 'LOW' && bias === 'NEUTRAL') {
            return 'MONK';
        }

        // CASE 4: BUNKER (Default / Uncertainty)
        return 'BUNKER';
    }

    private applyHysteresis(rawRegime: RegimeType): RegimeType {
        // CASE A: REGIME DID NOT CHANGE
        if (rawRegime === this.lastRegime) {
            // REINFORCE LOCK: Reset counter to maximum
            // This ensures if we're in WHALE and market flickers,
            // WE STAY IN WHALE firmly.
            this.regimeStickyCounter = this.REGIME_STICKY_THRESHOLD;
            return this.lastRegime;
        }

        // CASE B: CHANGE DETECTED
        // Start countdown for confirmation
        // Example: Threshold=3. Tick1(Change)->2, Tick2->1, Tick3->0(Switch).
        this.regimeStickyCounter--;

        // Check if grace period expired (Cooldown complete)
        if (this.regimeStickyCounter <= 0) {
            // CONFIRM REGIME CHANGE
            this.lastRegime = rawRegime;
            this.regimeStickyCounter = this.REGIME_STICKY_THRESHOLD; // Reset for new regime
            return rawRegime;
        }

        // Counter not at 0 yet - ignore new signal, keep old regime
        return this.lastRegime;
    }

    private calculateConfidence(snapshot: MarketSnapshot, regime: RegimeType): ConfidenceLevel {
        const { longProb, shortProb, neutralProb } = snapshot;
        const maxProb = Math.max(longProb, shortProb, neutralProb);

        // In BUNKER, we're uncertain by definition
        if (regime === 'BUNKER') return 'LOW';

        // High confidence if dominant probability is clear
        if (maxProb > 0.60) return 'HIGH';
        if (maxProb > 0.45) return 'MED';
        return 'LOW';
    }

    private getTriggerReason(regime: RegimeType, snapshot: MarketSnapshot): string {
        switch (regime) {
            case 'BLOODBATH':
                return `chaos_detected:neutral=${(snapshot.neutralProb * 100).toFixed(0)}%`;
            case 'WHALE':
                return `trend_detected:funding=${snapshot.fundingRate.toFixed(6)}`;
            case 'MONK':
                return `range_detected:spread=${(snapshot.spreadPct * 100).toFixed(4)}%`;
            case 'BUNKER':
            default:
                return 'uncertain_state';
        }
    }

    /**
     * Force reset the regime detector state (useful after position close)
     */
    reset(): void {
        this.lastRegime = 'BUNKER';
        this.regimeStickyCounter = 0;
    }
}
