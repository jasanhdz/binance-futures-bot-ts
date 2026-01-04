/**
 * Monk Strategy (Modo Range Hunter) v5.1
 * 
 * FILOSOFÍA: "Paciencia del monje, precisión del cirujano"
 * 
 * Activates during: Low volatility, ranging market, "boring" price action
 * Objective: Mean reversion - catch the full range movement
 * 
 * Lógica v5.1 (Range Hunter Mode):
 * 1. Hard Stop (Range broke) → -5%
 * 2. Fixed TP (Mean reversion target) → +2%
 * 3. Moderate Panic (>65%) → Only if ML is VERY SURE of reversal
 * 4. Breakeven protection → Lock minimal gains
 * 
 * ❌ REMOVED: MONK_NEUTRAL_EXIT
 * Reason: Caused "Fee Churning" - exiting at +0.3% doesn't cover commissions.
 * Trust the range. Wait for TP or Stop.
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
    // NINJA v5.1: MONK EVALUATE EXIT (Range Hunter Mode)
    // ═══════════════════════════════════════════════════════════════════════════
    evaluateExit(ctx: ExitContext, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // 1. HARD STOP (Range broke - structure failed)
        if (ctx.currentRoe < config.hardStopRoe) {
            return 'MONK_HARD_STOP';
        }

        // 2. FIXED TP (Mean reversion target hit - THE GOAL)
        if (ctx.currentRoe >= config.tpRoe) {
            return 'MONK_RANGE_TP';
        }

        // 3. MODERATE PANIC (Only if ML is VERY SURE of reversal)
        // In range, a strong opposing signal means breakout
        if (ctx.opposingProb > 0.65) {
            return 'MONK_PANIC_MODERATE';
        }

        // 4. BREAKEVEN PROTECTION
        // If we hit +1.5% peak and drop back to +0.3%, secure minimal gain
        const peakPct = ctx.peakRoe * 100;
        const currentPct = ctx.currentRoe * 100;
        if (peakPct > 1.5 && currentPct < 0.3 && currentPct > 0) {
            return 'MONK_BREAKEVEN_LOCK';
        }

        // ❌ REMOVED: MONK_NEUTRAL_EXIT
        // v5.0 had: if (ctx.currentRoe > 0 && ctx.neutralProb > 0.65) return 'MONK_NEUTRAL_EXIT';
        // Problem: Exited at +0.3%, +0.07% - didn't cover commissions
        // Solution: Trust the range. Wait for TP (+2%) or Hard Stop (-5%)

        return null;
    }
}
