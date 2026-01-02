/**
 * Whale Strategy (Modo Cazador)
 * 
 * Activates during: Strong sustained bias, aligned funding, smart money flow
 * Objective: Trend following with infinite TP (Moonbag)
 * Risk: MEDIUM-HIGH (configurable, default 5x leverage)
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';

export class WhaleStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'WHALE';

    /**
     * Returns config from regime_config.json with optional symbol override
     */
    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('WHALE', symbol);
    }

    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean {
        const config = this.getConfig(symbol);
        // In Whale mode, we need HIGH conviction. We're riding the trend.
        // Only enter if ML is strongly directional AND bias matches.
        const biasMatchesProb =
            (ctx.bias === 'BULL' && mlProb > config.entryThreshold) ||
            (ctx.bias === 'BEAR' && mlProb > config.entryThreshold);

        return biasMatchesProb;
    }

    getExitReason(currentRoe: number, peakRoe: number, holdTimeMs: number, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // 1. Hard Stop (Disaster protection)
        if (currentRoe < config.hardStopRoe) {
            return 'WHALE_HARD_STOP';
        }

        // 2. Parabolic Moonbag Trailing
        const trailingActivation = config.trailingActivationRoe ?? 0.03;

        if (peakRoe >= trailingActivation) {
            // Allow larger drawdowns at higher peaks (Parabolic logic)
            let allowedDrawdownPct: number;

            if (peakRoe > 0.30) {
                allowedDrawdownPct = 0.10; // At +30%, allow 10% drop
            } else if (peakRoe > 0.20) {
                allowedDrawdownPct = 0.10; // At +20%, allow 10% drop
            } else if (peakRoe > 0.12) {
                allowedDrawdownPct = 0.08; // At +12%, allow 8% drop
            } else if (peakRoe > 0.05) {
                allowedDrawdownPct = 0.04; // At +5%, allow 4% drop
            } else {
                allowedDrawdownPct = 0.02; // At +3%, allow 2% drop
            }

            const minSecureLevel = peakRoe - allowedDrawdownPct;

            if (currentRoe < minSecureLevel && minSecureLevel > 0) {
                return 'WHALE_TRAILING_SECURE';
            }
        }

        // 3. No fixed TP - let it run forever (Moonbag philosophy)
        return null;
    }
}
