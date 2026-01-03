/**
 * Monk Strategy (Modo Sweet Spot) v5.0
 * 
 * FILOSOFÍA: "Paciencia del monje, precisión del cirujano"
 * 
 * Activates during: Low volatility, ranging market, "boring" price action
 * Objective: Mean reversion scalping within the range
 * 
 * Lógica v5.0:
 * 1. Hard Stop (Range broke)
 * 2. Fixed TP (Mean reversion target)
 * 3. Moderate Panic (>65% - more tolerant than Bloodbath, less than Whale)
 * 4. Neutrality Exit (Si el rango pierde definición con ROI neutro)
 * 5. Breakeven protection
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType, ExitContext } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';

export class MonkStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'MONK';

    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('MONK', symbol);
    }

    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean {
        const config = this.getConfig(symbol);
        // In Monk mode, we're playing mean reversion.
        return mlProb >= config.entryThreshold && ctx.bias === 'NEUTRAL';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NINJA v5.0: MONK EVALUATE EXIT (Range Trading Logic)
    // ═══════════════════════════════════════════════════════════════════════════
    evaluateExit(ctx: ExitContext, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // 1. HARD STOP (Range broke - structure failed)
        if (ctx.currentRoe < config.hardStopRoe) {
            return 'MONK_HARD_STOP';
        }

        // 2. FIXED TP (Mean reversion target hit)
        if (ctx.currentRoe >= config.tpRoe) {
            return 'MONK_RANGE_TP';
        }

        // 3. MODERATE PANIC (Más tolerante que Bloodbath, menos que Whale)
        // En rango, un reversal moderado ya es señal de breakout
        if (ctx.opposingProb > 0.65) {
            return 'MONK_PANIC_MODERATE';
        }

        // 4. NEUTRALITY EXIT (Si perdemos dirección y no estamos en verde)
        // En rango, si el modelo se confunde y no ganamos, mejor salir
        if (ctx.neutralProb > 0.65 && ctx.currentRoe < 0.01 && ctx.currentRoe > -0.005) {
            return 'MONK_NEUTRAL_EXIT';
        }

        // 5. BREAKEVEN PROTECTION
        // If we hit +1.5% and drop back to +0.3%, secure the minuscule gain
        const peakPct = ctx.peakRoe * 100;
        const currentPct = ctx.currentRoe * 100;
        if (peakPct > 1.5 && currentPct < 0.3 && currentPct > 0) {
            return 'MONK_BREAKEVEN_LOCK';
        }

        return null;
    }
}
