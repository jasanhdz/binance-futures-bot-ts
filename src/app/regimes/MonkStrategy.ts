/**
 * Monk Strategy (Modo Sweet Spot)
 * 
 * Activates during: Low volatility, ranging market, "boring" price action
 * Objective: Mean reversion scalping within the range
 * Risk: MEDIUM (configurable, default 10x leverage)
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';

export class MonkStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'MONK';

    /**
     * Returns config from regime_config.json with optional symbol override
     */
    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('MONK', symbol);
    }

    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean {
        const config = this.getConfig(symbol);
        // In Monk mode, we're playing mean reversion.
        // Enter when ML gives moderate signal in a neutral bias environment.
        return mlProb >= config.entryThreshold && ctx.bias === 'NEUTRAL';
    }

    getExitReason(currentRoe: number, peakRoe: number, holdTimeMs: number, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // 1. Hard Stop (Range broke)
        if (currentRoe < config.hardStopRoe) {
            return 'MONK_HARD_STOP';
        }

        // 2. Fixed TP (Mean reversion target hit)
        if (currentRoe >= config.tpRoe) {
            return 'MONK_RANGE_TP';
        }

        // 3. Breakeven protection at peak
        // If we hit +1.5% and drop back to +0.3%, secure the minuscule gain
        if (peakRoe > 0.015 && currentRoe < 0.003 && currentRoe > 0) {
            return 'MONK_BREAKEVEN_LOCK';
        }

        return null;
    }
}
