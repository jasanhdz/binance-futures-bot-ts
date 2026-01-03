/**
 * Whale Strategy (Modo Cazador) v5.0
 * 
 * FILOSOFÍA: "Las ballenas aguantan el mareo, pero saltan si el iceberg se mueve"
 * 
 * Lógica de salida consolidada:
 * 1. Hard Stop (Protección de capital)
 * 2. Moonbag Secure (Asegurar ganancias escalonadas)
 * 3. Trailing Logarítmico (Dejar correr tendencias)
 * 4. Panic Extremo (Solo reversales catastróficos >80%)
 * 5. Neutralidad: IGNORADA (trends respiran)
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType, ExitContext } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';

export class WhaleStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'WHALE';

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
    // NINJA v5.0: WHALE EVALUATE EXIT (Trend Follower Logic)
    // ═══════════════════════════════════════════════════════════════════════════
    evaluateExit(ctx: ExitContext, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        const peakPct = ctx.peakRoe * 100;
        const currentPct = ctx.currentRoe * 100;

        // 1. HARD STOP (Corte seco - Protección de capital)
        if (ctx.currentRoe < config.hardStopRoe) {
            return 'WHALE_HARD_STOP';
        }

        // 2. MOONBAG AGRESIVO (Secure Threshold)
        // Protege ganancias permitiendo respiración profunda en parábolas
        if (peakPct > 1.5) {
            let secureThreshold = -999;

            if (peakPct > 30.0) secureThreshold = peakPct - 10.0;
            else if (peakPct > 20.0) secureThreshold = peakPct - 10.0;
            else if (peakPct > 12.0) secureThreshold = peakPct - 8.0;
            else if (peakPct > 8.0) secureThreshold = 2.5;
            else if (peakPct > 5.0) secureThreshold = 1.5;
            else secureThreshold = 0.5;

            if (secureThreshold > -999 && currentPct < secureThreshold) {
                return 'WHALE_MOONBAG_SECURE';
            }
        }

        // 3. TRAILING LOGARÍTMICO (Fórmula Continua)
        if (peakPct > 5) {
            const safePeak = Math.max(5, peakPct);
            let baseTrail = 30 - (22 * Math.log10(safePeak / 5));
            baseTrail = Math.max(8, Math.min(30, baseTrail)); // Clamp 8%-30%

            const stopThreshold = peakPct * (1 - (baseTrail / 100));

            if (currentPct < stopThreshold) {
                return 'WHALE_LOGARITHMIC_TRAIL';
            }
        }

        // 4. PANIC EXTREMO (Solo reversales catastróficos)
        // Las ballenas aguantan el "mareo" (rumor), pero saltan si el iceberg se mueve (>80%)
        if (ctx.opposingProb > 0.80) {
            return 'WHALE_PANIC_EXTREME';
        }

        // 5. NEUTRALIDAD: WHALE IGNORA
        // "Whales don't exit on neutrality - trends continue even in indecision"
        // Mantener posición. El Trailing Stop ya nos protegerá si la tendencia se rompe.

        return null;
    }
}
