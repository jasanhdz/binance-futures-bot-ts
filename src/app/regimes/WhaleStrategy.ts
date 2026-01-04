/**
 * Whale Strategy (Modo Cazador) v5.1 (Universal Guardian Integration)
 * 
 * FILOSOFÍA: "Las ballenas aguantan el mareo, pero saltan si el iceberg se mueve"
 * 
 * v5.1 Changes:
 * - Integrated UniversalProfitGuardian for dynamic trailing
 * - Removed manual Moonbag/Trailing logic (delegated to Guardian)
 * - Hard Stop and Panic remain as safety cuts
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType, ExitContext } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';
import { UniversalProfitGuardian, GuardianContext } from '../core/UniversalProfitGuardian';

export class WhaleStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'WHALE';

    private profitGuardian = new UniversalProfitGuardian(UniversalProfitGuardian.WHALE_CONFIG);

    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('WHALE', symbol);
    }

    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean {
        const config = this.getConfig(symbol);
        const biasMatchesProb =
            (ctx.bias === 'BULL' && mlProb > config.entryThreshold) ||
            (ctx.bias === 'BEAR' && mlProb > config.entryThreshold);
        return biasMatchesProb;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NINJA v5.1: WHALE EVALUATE EXIT (Universal Guardian Integration)
    // ═══════════════════════════════════════════════════════════════════════════
    evaluateExit(ctx: ExitContext, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // 1. HARD STOP (Capital Protection)
        if (ctx.currentRoe < config.hardStopRoe) {
            return 'WHALE_HARD_STOP';
        }

        // 2. FIXED TP (WHALE uses 999, so this effectively never triggers)
        if (ctx.currentRoe >= config.tpRoe) {
            return 'WHALE_RANGE_TP';
        }

        // 3. PANIC EXTREMO (Only catastrophic reversals >80%)
        if (ctx.opposingProb > 0.80) {
            return 'WHALE_PANIC_EXTREME';
        }

        // 4. UNIVERSAL PROFIT GUARDIAN (v5.1)
        // Replaces WHALE_MOONBAG_SECURE and WHALE_LOGARITHMIC_TRAIL
        const guardianCtx: GuardianContext = {
            peakRoe: ctx.peakRoe,
            currentRoe: ctx.currentRoe,
            volatilityFactor: ctx.volatilityFactor,
            marketBias: ctx.marketBias,
            positionSide: ctx.positionSide
        };

        if (this.profitGuardian.evaluate(guardianCtx)) {
            return 'WHALE_DYNAMIC_LOCK';
        }

        // 5. NEUTRALITY: WHALE IGNORES
        // Trends continue even in indecision
        return null;
    }
}
