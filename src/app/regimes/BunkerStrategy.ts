/**
 * Bunker Strategy (Modo Idle)
 * 
 * Activates during: Total uncertainty, conflicting signals, no clear direction
 * Objective: Capital preservation - stay in cash
 * Risk: ZERO (0x leverage)
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';

export class BunkerStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'BUNKER';

    /**
     * Returns config from regime_config.json with optional symbol override
     */
    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('BUNKER', symbol);
    }

    shouldEnter(_mlProb: number, _ctx: RegimeContext, _symbol?: string): boolean {
        // BUNKER MODE: NEVER ENTER
        return false;
    }

    getExitReason(currentRoe: number, peakRoe: number, _holdTimeMs: number, _symbol?: string): string | null {
        // BUNKER: Let the market decide, not a timer
        // Only exit if:
        // 1. Hit hard stop (-5%)
        // 2. Trailing stop: was profitable, then fell back significantly

        const HARD_STOP = -0.05; // -5% ROI
        const TRAILING_ACTIVATION = 0.01; // 1% profit activates trailing
        const TRAILING_DRAWDOWN = 0.5; // Close if fell to 50% of peak

        // Hard stop - protect capital
        if (currentRoe < HARD_STOP) {
            return 'BUNKER_STOP_LOSS';
        }

        // Trailing stop - was winning, now giving back too much
        if (peakRoe > TRAILING_ACTIVATION && currentRoe < peakRoe * TRAILING_DRAWDOWN) {
            return 'BUNKER_TRAILING_EXIT';
        }

        // No timer - stay in position, let market decide
        return null;
    }
}
