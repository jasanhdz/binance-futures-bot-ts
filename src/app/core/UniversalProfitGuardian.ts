/**
 * NINJA v7.0: Universal Dynamic Profit Guardian (Logarithmic Edition)
 * * Features:
 * - Tiered Drawdown: Tightens risk as profits grow.
 * - Volatility Awareness: Loosens grip in high volatility.
 */

export interface GuardianContext {
    peakRoe: number;          // Peak ROE (0.20 = 20%)
    currentRoe: number;       // Current ROE
    volatilityFactor: number; // 1.0 = Normal, 2.0 = High Vol
    marketBias: 'BULL' | 'BEAR' | 'NEUTRAL';
    positionSide: 'LONG' | 'SHORT';
}

export interface GuardianConfig {
    peakThreshold: number;       // Min peak to activate (0.01)
    baseDrawdown: number;        // Initial allowed drop
    volatilitySensitivity: number;
    enableTrendProtection: boolean;
    drawdownMode?: 'LINEAR' | 'LOG'; // New flag for Berzerker
}

export class UniversalProfitGuardian {
    private config: GuardianConfig;

    constructor(config: GuardianConfig) {
        this.config = config;
    }

    evaluate(ctx: GuardianContext): boolean {
        // 1. NOISE FILTER
        if (ctx.peakRoe < this.config.peakThreshold) return false;

        // 2. CALCULATE DRAWDOWN FROM PEAK
        const drawdown = ctx.peakRoe - ctx.currentRoe;
        let dynamicAllowedDD;

        // 3. DRAWDOWN CALCULATION STRATEGY
        if (this.config.drawdownMode === 'LINEAR') {
            // ══════════════════════════════════════════════════════════════
            // MODO BERZERKER: SOGA LINEAL 30% (Legacy Bot 1.0)
            // ══════════════════════════════════════════════════════════════
            // La soga es siempre un % del punto más alto.
            dynamicAllowedDD = ctx.peakRoe * this.config.baseDrawdown;

            // Mínimo de seguridad de 1% ROI para evitar que micro-ticks nos saquen al inicio
            dynamicAllowedDD = Math.max(0.01, dynamicAllowedDD);
        } else {
            // ══════════════════════════════════════════════════════════════
            // MODO STANDARD: LOGARITHMIC TIGHTENING
            // ══════════════════════════════════════════════════════════════
            // A medida que el ROE sube, el drawdown permitido baja.
            // ROE 2%  -> Permite ceder 40% de la ganancia
            // ROE 10% -> Permite ceder 20% de la ganancia
            // ROE 50% -> Permite ceder 10% de la ganancia

            dynamicAllowedDD = this.config.baseDrawdown;

            if (ctx.peakRoe > 0.05) { // Si ganamos > 5%
                // Fórmula de endurecimiento: Reduce el DD a la mitad cada vez que duplicas ganancia
                const tighteningFactor = 1 / (1 + ctx.peakRoe * 5);
                dynamicAllowedDD = this.config.baseDrawdown * tighteningFactor;

                // Límite duro: Nunca menos del 5% de la ganancia (para respirar)
                dynamicAllowedDD = Math.max(0.05, dynamicAllowedDD);
            }
        }

        // 4. VOLATILITY ADJUSTMENT
        // Si hay mucha volatilidad, aflojamos un poco para no salir por un wick
        let volMultiplier = 1.0;
        if (ctx.volatilityFactor > 1.2) {
            volMultiplier = 1.2; // 20% más de espacio
        }

        const finalLimit = dynamicAllowedDD * volMultiplier;

        // AUDIT LOG (Berzerker Monitor)
        if (ctx.peakRoe > 0.05) {
            console.log(`[Guardian] 🛡️ Drawdown: ${(drawdown * 100).toFixed(2)}% / Limit: ${(finalLimit * 100).toFixed(2)}% | Peak: ${(ctx.peakRoe * 100).toFixed(2)}%`);
        }

        // 5. DECISION
        if (drawdown >= finalLimit) {
            // Trend Protection: Si el ML sigue MUY convencido, damos una última oportunidad
            // Solo si el drawdown no es catastrófico (ej. no perder más del 50% de lo ganado)
            if (this.config.enableTrendProtection && drawdown < ctx.peakRoe * 0.5) {
                const biasFavors = (ctx.positionSide === 'LONG' && ctx.marketBias === 'BULL') ||
                    (ctx.positionSide === 'SHORT' && ctx.marketBias === 'BEAR');
                if (biasFavors) return false;
            }
            return true; // CLOSE
        }

        return false; // HOLD
    }

    // CONFIGURACIONES AGRESIVAS (DEJAR CORRER)
    static WHALE_CONFIG: GuardianConfig = {
        peakThreshold: 0.015,
        baseDrawdown: 0.40, // Empezamos cediendo 40% del pico
        volatilitySensitivity: 0.2,
        enableTrendProtection: true
    };

    static MONK_CONFIG: GuardianConfig = {
        peakThreshold: 0.01,
        baseDrawdown: 0.30, // En rango somos un poco más estrictos
        volatilitySensitivity: 0.3,
        enableTrendProtection: true
    };

    static BLOODBATH_CONFIG: GuardianConfig = {
        peakThreshold: 0.005,
        baseDrawdown: 0.15, // En caos salimos rápido
        volatilitySensitivity: 0.5,
        enableTrendProtection: false
    };

    static BERZERKER_CONFIG: GuardianConfig = {
        peakThreshold: 0.05,       // Empezar a vigilar al +5% ROI
        baseDrawdown: 0.30,        //  LA SOGA DEL 30% EXACTO
        volatilitySensitivity: 0.5,
        enableTrendProtection: true,
        drawdownMode: 'LINEAR'     // ACTIVAR MODO LINEAL
    };
}
