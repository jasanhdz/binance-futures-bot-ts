/**
 * Whale Strategy (Modo Cazador) v4.1 (Consolidated)
 * 
 * Centraliza toda la lógica de salida:
 * 1. Hard Stop (YAML)
 * 2. Moonbag Secure (Ex-CAPA 0.5)
 * 3. Trailing Logarítmico (Ex-CAPA 2)
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';

export class WhaleStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'WHALE';

    getConfig(symbol?: string): RegimeConfig {
        return getNinjaConfig().getRegimeConfig('WHALE', symbol);
    }

    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean {
        const config = this.getConfig(symbol);
        // Solo entrar si hay convicción alta y el sesgo coincide
        const biasMatchesProb =
            (ctx.bias === 'BULL' && mlProb > config.entryThreshold) ||
            (ctx.bias === 'BEAR' && mlProb > config.entryThreshold);
        return biasMatchesProb;
    }

    getExitReason(currentRoe: number, peakRoe: number, holdTimeMs: number, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // INPUT: currentRoe y peakRoe vienen en DECIMALES (ej. 0.05 = 5%)
        // Convertimos a PORCENTAJE para facilitar la lógica de "Moonbag"
        const peakPct = peakRoe * 100;
        const currentPct = currentRoe * 100;

        // 1. HARD STOP (Corte seco por liquidación o quiebra de régimen)
        if (currentRoe < config.hardStopRoe) {
            return 'WHALE_HARD_STOP';
        }

        // 2. MOONBAG AGRESIVO (Secure Threshold)
        // Protege ganancias permitiendo respiración profunda en parábolas
        if (peakPct > 1.5) {
            let secureThreshold = -999; // Inactivo por defecto

            if (peakPct > 30.0) {
                secureThreshold = peakPct - 10.0; // Ej: 40% -> Cortar a 30%
            } else if (peakPct > 20.0) {
                secureThreshold = peakPct - 10.0; // Ej: 25% -> Cortar a 15%
            } else if (peakPct > 12.0) {
                secureThreshold = peakPct - 8.0;  // Ej: 14% -> Cortar a 6%
            } else if (peakPct > 8.0) {
                secureThreshold = 2.5;           // Asegurar ganancia mínima
            } else if (peakPct > 5.0) {
                secureThreshold = 1.5;           // Breakeven agresivo
            } else {
                secureThreshold = 0.5;           // Cubrir fees
            }

            if (secureThreshold > -999 && currentPct < secureThreshold) {
                return 'WHALE_MOONBAG_SECURE';
            }
        }

        // 3. TRAILING LOGARÍTMICO (Continuo)
        // Fórmula suave para permitir runs largos sin salir por ruido
        if (peakPct > 5) {
            const safePeak = Math.max(5, peakPct);
            let baseTrail = 30 - (22 * Math.log10(safePeak / 5));
            // Clamp entre 8% y 30%
            baseTrail = Math.max(8, Math.min(30, baseTrail));

            const stopThreshold = peakPct * (1 - (baseTrail / 100));

            if (currentPct < stopThreshold) {
                return 'WHALE_LOGARITHMIC_TRAIL';
            }
        }

        // Mantener posición
        return null;
    }
}
