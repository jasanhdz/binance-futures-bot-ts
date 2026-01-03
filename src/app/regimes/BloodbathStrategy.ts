/**
 * Bloodbath Strategy (Modo Sangriento) v5.0
 * 
 * FILOSOFÍA: "En el caos, reacciona rápido o muere rápido"
 * 
 * Activates during: Panic, Extreme Volatility, Wide Spreads, OBI spikes
 * Objective: High-frequency scalping to extract liquidity from chaos
 * 
 * Lógica v5.0:
 * 1. Hard Stop (Aprieta el cinturón)
 * 2. Micro TP (Take the scalp)
 * 3. Fast Panic (Reacción inmediata >55%)
 * 4. Neutrality Exit (Tomar ganancias rápidas en indecisión)
 * 5. Time Decay (Don't overstay)
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType, ExitContext } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';

export class BloodbathStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'BLOODBATH';

    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('BLOODBATH', symbol);
    }

    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean {
        const config = this.getConfig(symbol);
        // In Bloodbath, we're scalping chaos. Enter aggressively.
        return mlProb >= config.entryThreshold;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NINJA v5.0: BLOODBATH EVALUATE EXIT (Chaos Logic)
    // ═══════════════════════════════════════════════════════════════════════════
    evaluateExit(ctx: ExitContext, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // 1. HARD STOP (Aprieta el cinturón)
        if (ctx.currentRoe < config.hardStopRoe) {
            return 'BLOODBATH_HARD_STOP';
        }

        // 2. MICRO TP (Take the scalp)
        if (ctx.currentRoe >= config.tpRoe) {
            return 'BLOODBATH_MICRO_TP';
        }

        // 3. FAST PANIC (Reacción inmediata - Mercado caótico)
        // Umbral bajo (0.55) porque en BLOODBATH todo cambia muy rápido
        if (ctx.opposingProb > 0.55) {
            return 'BLOODBATH_PANIC_FAST';
        }

        // 4. NEUTRALITY EXIT (Tomar ganancias rápidas)
        // Si estás ganando y el mercado se queda sin dirección, sal y asegúrate
        if (ctx.currentRoe > config.tpRoe * 0.5 && ctx.neutralProb > 0.50) {
            return 'BLOODBATH_NEUTRAL_EXIT';
        }

        // 5. TIME DECAY (Don't overstay - this regime is about speed)
        if (config.maxHoldMs && ctx.holdTimeMs > config.maxHoldMs) {
            if (ctx.currentRoe > -0.002) {
                return 'BLOODBATH_TIME_DECAY';
            }
        }

        return null;
    }
}
