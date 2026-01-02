/**
 * Bloodbath Strategy (Modo Sangriento)
 * 
 * Activates during: Panic, Extreme Volatility, Wide Spreads, OBI spikes
 * Objective: High-frequency scalping to extract liquidity from chaos
 * Risk: EXTREME (configurable, default 15x leverage)
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';

export class BloodbathStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'BLOODBATH';

    /**
     * Returns config from regime_config.json with optional symbol override
     */
    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('BLOODBATH', symbol);
    }

    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean {
        const config = this.getConfig(symbol);
        // In Bloodbath, we're scalping chaos. Enter aggressively.
        // The stop is so tight (-1.5%) that we can afford to be trigger-happy.
        return mlProb >= config.entryThreshold;
    }

    getExitReason(currentRoe: number, peakRoe: number, holdTimeMs: number, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // 1. Hard Stop (Pain threshold)
        if (currentRoe < config.hardStopRoe) {
            return 'BLOODBATH_HARD_STOP';
        }

        // 2. Micro TP (Take the scalp)
        if (currentRoe >= config.tpRoe) {
            return 'BLOODBATH_MICRO_TP';
        }

        // 3. Time Decay (Don't overstay - this regime is about speed)
        if (config.maxHoldMs && holdTimeMs > config.maxHoldMs) {
            // Exit at breakeven or small profit if possible
            if (currentRoe > -0.002) {
                return 'BLOODBATH_TIME_DECAY';
            }
        }

        return null;
    }
}
