/**
 * Berzerker Strategy (Modo Dios) v1.0
 * 
 * FILOSOFÍA: "Entrar con todo en la Ola, salir al primer signo de debilidad"
 * Inspirado en el Bot 1.0 ($20 -> $1200)
 * 
 * Configuración:
 * - Leverage: 50x
 * - Entry: Solo con señal de "Ola" (Berzerker Score > 0.8)
 * - Exit: UniversalProfitGuardian (Strict) + Panic
 */

import { IRegimeStrategy, RegimeConfig, RegimeContext, RegimeType, ExitContext } from './RegimeStrategy';
import { getNinjaConfig } from '../core/NinjaConfigManager';
import { UniversalProfitGuardian, GuardianContext } from '../core/UniversalProfitGuardian';

export class BerzerkerStrategy implements IRegimeStrategy {
    readonly name: RegimeType = 'BERZERKER';

    private profitGuardian = new UniversalProfitGuardian(UniversalProfitGuardian.BERZERKER_CONFIG);

    getConfig(symbol?: string): RegimeConfig {
        // Configuración Hardcoded para Berzerker (o podría venir de YAML)
        // Por seguridad, usamos defaults agresivos aquí si no están en YAML
        const yamlConfig = getNinjaConfig().getRegimeConfig('BERZERKER', symbol);

        return {
            ...yamlConfig,
            leverage: 50, // FORCE 50x
            entryThreshold: 0.90, // Solo entradas muy claras
            hardStopRoe: -0.15, // Stop al -15% ROE (0.3% precio) - Fusible rápido
        };
    }

    shouldEnter(mlProb: number, ctx: RegimeContext, symbol?: string): boolean {
        const config = this.getConfig(symbol);

        // Berzerker ignora ML puro si la señal de Ola no está presente
        // Pero aquí 'ctx' ya viene del RegimeDetector que validó el score.
        // Así que si estamos en régimen BERZERKER, confiamos en la dirección del ML.

        const biasMatchesProb =
            (ctx.bias === 'BULL' && mlProb > config.entryThreshold) ||
            (ctx.bias === 'BEAR' && mlProb > config.entryThreshold);

        return biasMatchesProb;
    }

    evaluateExit(ctx: ExitContext, symbol?: string): string | null {
        const config = this.getConfig(symbol);

        // 1. HARD STOP (Safety Net)
        if (ctx.currentRoe <= config.hardStopRoe) {
            return 'BERZERKER_HARD_STOP';
        }

        // 2. PANIC (Si la probabilidad se da vuelta, SALIR YA)
        // En 50x no podemos esperar a que el ML cambie de opinión lentamente.
        if (ctx.opposingProb > 0.60) {
            return 'BERZERKER_PANIC_REVERSAL';
        }

        // 3. UNIVERSAL PROFIT GUARDIAN
        const guardianCtx: GuardianContext = {
            peakRoe: ctx.peakRoe,
            currentRoe: ctx.currentRoe,
            volatilityFactor: ctx.volatilityFactor,
            marketBias: ctx.marketBias,
            positionSide: ctx.positionSide
        };

        if (this.profitGuardian.evaluate(guardianCtx)) {
            return 'BERZERKER_PROFIT_GUARD';
        }

        return null;
    }
}
