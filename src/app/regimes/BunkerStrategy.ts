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

    getExitReason(_currentRoe: number, _peakRoe: number, _holdTimeMs: number, _symbol?: string): string | null {
        // If somehow we have a position in Bunker mode, close it immediately
        return 'BUNKER_EMERGENCY_EXIT';
    }
}
