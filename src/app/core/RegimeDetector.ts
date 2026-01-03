/**
 * Regime Detector v5.0
 * 
 * The "Brain" of Ninja System v5.0
 * Analyzes market micro-state to determine which Regime is active.
 * 
 * v5.0 Changes:
 * - Dynamic hysteresis thresholds per regime
 * - Bloodbath: 15s (fast regime changes in chaos)
 * - Whale: 60s (stable regime for trends)
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

    // ═══════════════════════════════════════════════════════════════════════════
    // NINJA v5.0: HYSTERESIS DINÁMICA POR RÉGIMEN
    // ═══════════════════════════════════════════════════════════════════════════
    // Bloodbath necesita cambios rápidos, Whale necesita estabilidad
    private getHysteresisThreshold(regime: RegimeType): number {
        const thresholds: Record<RegimeType, number> = {
            BLOODBATH: 3,   // 15s (Caos = Reacción rápida)
            WHALE: 12,      // 60s (Tendencia = Estabilidad)
            MONK: 6,        // 30s (Rango = Moderado)
            BUNKER: 2       // 10s (Incertidumbre = Salir/Entrar rápido)
        };
        return thresholds[regime] ?? 6;
    }

    /**
     * Analyzes market data to determine the active trading regime.
     * Implements dynamic hysteresis to prevent regime flickering.
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

        // 4. Apply Dynamic Hysteresis (v5.0)
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
        if (volatility === 'HIGH' && neutralProb > 0.50) {
            return 'BLOODBATH';
        }

        // CASE 2: WHALE (Strong Trend - Med Volatility)
        if (volatility === 'MED' && bias !== 'NEUTRAL') {
            const fundingAligned =
                (bias === 'BULL' && fundingRate > 0) ||
                (bias === 'BEAR' && fundingRate < 0);

            const obiAligned =
                (bias === 'BULL' && obi > 0.1) ||
                (bias === 'BEAR' && obi < -0.1);

            if (fundingAligned || obiAligned) {
                return 'WHALE';
            }
        }

        // CASE 3: WHALE (Slow Trend - Low Volatility with bias)
        if (volatility === 'LOW' && bias !== 'NEUTRAL') {
            return 'WHALE';
        }

        // CASE 4: MONK (Sweet Spot / Range)
        if (volatility === 'LOW' && bias === 'NEUTRAL') {
            return 'MONK';
        }

        // CASE 5: BUNKER (Default / Uncertainty)
        return 'BUNKER';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NINJA v5.0: HYSTERESIS DINÁMICA
    // ═══════════════════════════════════════════════════════════════════════════
    private applyHysteresis(rawRegime: RegimeType): RegimeType {
        // Get dynamic threshold based on CURRENT regime (not the new one)
        const stickyThreshold = this.getHysteresisThreshold(this.lastRegime);

        // CASE A: REGIME DID NOT CHANGE - reinforce lock
        if (rawRegime === this.lastRegime) {
            this.regimeStickyCounter = stickyThreshold;
            return this.lastRegime;
        }

        // CASE B: CHANGE DETECTED - start countdown
        this.regimeStickyCounter--;

        // Check if grace period expired (Cooldown complete)
        if (this.regimeStickyCounter <= 0) {
            // CONFIRM REGIME CHANGE
            this.lastRegime = rawRegime;
            // Reset counter using NEW regime's threshold
            this.regimeStickyCounter = this.getHysteresisThreshold(rawRegime);
            return rawRegime;
        }

        // Counter not at 0 yet - ignore new signal, keep old regime
        return this.lastRegime;
    }

    private calculateConfidence(snapshot: MarketSnapshot, regime: RegimeType): ConfidenceLevel {
        const { longProb, shortProb, neutralProb } = snapshot;
        const maxProb = Math.max(longProb, shortProb, neutralProb);

        if (regime === 'BUNKER') return 'LOW';
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
