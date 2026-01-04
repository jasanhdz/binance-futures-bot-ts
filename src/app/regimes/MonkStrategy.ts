/**
 * Monk Strategy (Modo Range Hunter) v5.1 (Universal Guardian Integration)
 * 
 * FILOSOFÍA: "Paciencia del monje, precisión del cirujano"
 * 
 * v5.1 Changes:
 * - REMOVED MONK_NEUTRAL_EXIT (caused fee churning)
 * - Integrated UniversalProfitGuardian for dynamic protection
 * - Only TP (+2%), Hard Stop (-5%), and Guardian exits
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType, ExitContext } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';
import { UniversalProfitGuardian, GuardianContext } from '../core/UniversalProfitGuardian';

export class MonkStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'MONK';

    private profitGuardian = new UniversalProfitGuardian(UniversalProfitGuardian.MONK_CONFIG);

    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('MONK', symbol);
    }

    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean {
        const config = this.getConfig(symbol);
        return mlProb >= config.entryThreshold && ctx.bias === 'NEUTRAL';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NINJA v5.1: MONK EVALUATE EXIT (Universal Guardian Integration)
    // ═══════════════════════════════════════════════════════════════════════════
    evaluateExit(ctx: ExitContext, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // 1. HARD STOP (Range broke)
        if (ctx.currentRoe < config.hardStopRoe) {
            return 'MONK_HARD_STOP';
        }

        // 2. FIXED TP (Mean reversion target - THE GOAL)
        if (ctx.currentRoe >= config.tpRoe) {
            return 'MONK_RANGE_TP';
        }

        // 3. UNIVERSAL PROFIT GUARDIAN (v5.1)
        // Replaces MONK_NEUTRAL_EXIT and MONK_PEAK_LOCK
        const guardianCtx: GuardianContext = {
            peakRoe: ctx.peakRoe,
            currentRoe: ctx.currentRoe,
            volatilityFactor: ctx.volatilityFactor,
            marketBias: ctx.marketBias,
            positionSide: ctx.positionSide
        };

        if (this.profitGuardian.evaluate(guardianCtx)) {
            return 'MONK_DYNAMIC_LOCK';
        }

        // ❌ REMOVED v5.1.1: MONK_BREAKEVEN_LOCK
        // Cause: Closed at +0.22% when peak was +1.88% (XRP bug)
        // Solution: Guardian handles dynamic drawdown better

        // ❌ REMOVED: MONK_NEUTRAL_EXIT (caused fee churning)

        return null;
    }
}
