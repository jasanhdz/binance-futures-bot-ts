/**
 * Bunker Strategy (Modo Refugio) v5.0
 * 
 * FILOSOFÍA: "Cuando no sabes qué hacer, no hagas nada"
 * 
 * Activates during: Total uncertainty, conflicting signals, no clear direction
 * Objective: Capital preservation - manage existing positions only
 * Risk: ZERO (0x leverage for new entries)
 * 
 * Lógica v5.0:
 * - NUNCA entra posiciones nuevas
 * - Si ya tiene posición, la gestiona con trailing conservador
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType, ExitContext } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';

export class BunkerStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'BUNKER';

    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('BUNKER', symbol);
    }

    shouldEnter(_mlProb: number, _ctx: RegimeContext, _symbol?: string): boolean {
        // BUNKER MODE: NEVER ENTER NEW POSITIONS
        return false;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NINJA v5.0: BUNKER EVALUATE EXIT (Survival Logic)
    // ═══════════════════════════════════════════════════════════════════════════
    evaluateExit(ctx: ExitContext, _symbol?: string): string | null {
        const HARD_STOP = -0.05;           // -5% ROI
        const TRAILING_ACTIVATION = 0.01;   // 1% profit activates trailing
        const TRAILING_DRAWDOWN = 0.5;      // Close if fell to 50% of peak

        // 1. HARD STOP - protect capital (BUNKER = survival mode)
        if (ctx.currentRoe < HARD_STOP) {
            return 'BUNKER_STOP_LOSS';
        }

        // 2. ANY SIGNIFICANT OPPOSING SIGNAL - exit quickly in uncertainty
        // Bunker is paranoid - even 60% opposing is enough to bail
        if (ctx.opposingProb > 0.60) {
            return 'BUNKER_PANIC_EXIT';
        }

        // 3. TRAILING STOP - was winning, now giving back too much
        if (ctx.peakRoe > TRAILING_ACTIVATION && ctx.currentRoe < ctx.peakRoe * TRAILING_DRAWDOWN) {
            return 'BUNKER_TRAILING_EXIT';
        }

        // 4. NEUTRALITY - In bunker, neutrality is a sign to exit if profitable
        if (ctx.currentRoe > 0.005 && ctx.neutralProb > 0.55) {
            return 'BUNKER_NEUTRAL_SECURE';
        }

        return null;
    }
}
