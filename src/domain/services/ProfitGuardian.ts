/**
 * ProfitGuardian - Domain Service
 * 
 * Dynamic trailing profit protection & Break-Even logic.
 * Dynamic protection logic for Aegis-managed futures positions.
 */

export interface GuardianContext {
    entryPrice: number;
    currentPrice: number;
    peakPrice: number;      // Best price seen (Lowest for SHORT, Highest for LONG)
    positionSide: 'LONG' | 'SHORT';
    leverage: number;
    peakRoe?: number;       // PARITY FIX: Track max ROE seen to trigger BE intra-candle
    atrValue?: number;      // Actual ATR value for dynamic trailing
}

export interface GuardianConfig {
    beTriggerRoe: number;   // e.g. 0.10 (10%)
    beOffsetPct: number;    // e.g. 0.003 (0.3% to cover fees)
    trailingDev: number;    // e.g. 0.015 (1.5% deviation)
    trailingActivationRoe?: number; // Safety Net Activation
    trailingCallbackRoe?: number;   // Safety Net Callback
    useAtrTrailing?: boolean;       // Enable ATR mode
    atrMultiplier?: number;         // e.g. 2.0 (2x ATR)
    minimumProtectedRoeRatio?: number; // e.g. 0.70 = protect at least 70% of peak ROE
    minimumProtectedRoeAbs?: number;   // e.g. 0.20 = absolute floor of 20% ROE
}

export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
    beTriggerRoe: 0.10,
    beOffsetPct: 0.003,
    trailingDev: 0.015,
    trailingActivationRoe: 0.15,
    trailingCallbackRoe: 0.30,
    useAtrTrailing: true,
    atrMultiplier: 2.0,
    minimumProtectedRoeRatio: 0.70,
    minimumProtectedRoeAbs: 0.20
};

export type GuardianAction =
    | { type: 'HOLD' }
    | { type: 'MOVE_SL_BE', price: number }
    | { type: 'MOVE_SL_TRAILING', price: number }
    | { type: 'CLOSE_MARKET', reason: string };

/**
 * Evaluates position and recommends action (BE, Trailing, or Hold)
 */
export function evaluateGuardianAction(
    ctx: GuardianContext,
    config: GuardianConfig,
    currentSlPrice?: number
): GuardianAction {
    const { entryPrice, currentPrice, peakPrice, positionSide, leverage, peakRoe, atrValue } = ctx;

    // 1. Calculate ROE
    const roe = positionSide === 'SHORT'
        ? (entryPrice - currentPrice) / entryPrice * leverage
        : (currentPrice - entryPrice) / entryPrice * leverage;

    // 2. Safety Net / Trailing Logic (Priority)
    // If Peak ROE > Activation, use Callback logic
    const activationRoe = config.trailingActivationRoe ?? 999;
    const callbackRoe = config.trailingCallbackRoe ?? 0;
    const currentPeakRoe = peakRoe ?? roe;

    if (currentPeakRoe >= activationRoe) {
        let triggerPrice = 0;

        // Si tenemos ATR habilitado y un valor de ATR válido, calculamos el Trailing dinámicamente
        if (config.useAtrTrailing && config.atrMultiplier && atrValue && atrValue > 0) {
            const trailingDistance = atrValue * config.atrMultiplier;
            const atrTriggerPrice = positionSide === 'SHORT'
                ? peakPrice + trailingDistance
                : peakPrice - trailingDistance;

            // Calculate ROE at ATR-based trigger price
            const roeAtAtrTrigger = positionSide === 'SHORT'
                ? (entryPrice - atrTriggerPrice) / entryPrice * leverage
                : (atrTriggerPrice - entryPrice) / entryPrice * leverage;

            // Apply dynamic protection floor
            const minimumProtectedRoe = Math.max(
                currentPeakRoe * (config.minimumProtectedRoeRatio ?? 0.70),
                config.minimumProtectedRoeAbs ?? 0.20
            );

            if (roeAtAtrTrigger < minimumProtectedRoe) {
                // ATR is too loose - use floor instead
                triggerPrice = positionSide === 'SHORT'
                    ? entryPrice * (1 - (minimumProtectedRoe / leverage))
                    : entryPrice * (1 + (minimumProtectedRoe / leverage));
            } else {
                triggerPrice = atrTriggerPrice;
            }
        } else {
            // Legacy / Fijo basado en porcentaje de ROE devuelto
            const triggerRoe = currentPeakRoe * (1 - callbackRoe);
            triggerPrice = positionSide === 'SHORT'
                ? entryPrice * (1 - (triggerRoe / leverage))
                : entryPrice * (1 + (triggerRoe / leverage));
        }

        // Check if we should CLOSE NOW
        const shouldClose = positionSide === 'SHORT'
            ? currentPrice >= triggerPrice
            : currentPrice <= triggerPrice;

        if (shouldClose) {
            return { type: 'CLOSE_MARKET', reason: 'TRAILING_SAFETY_NET' };
        }

        // Check if we should MOVE SL
        // Only move if new trigger price is better than current SL
        const isBetter = currentSlPrice ? (
            positionSide === 'SHORT'
                ? triggerPrice < currentSlPrice
                : triggerPrice > currentSlPrice
        ) : true;

        if (isBetter) {
            return { type: 'MOVE_SL_TRAILING', price: triggerPrice };
        }
    }

    // 3. Break-Even Logic (Fallback if Safety Net not active)
    // If ROE > Trigger AND we haven't moved SL yet (approx check)
    const bePrice = positionSide === 'SHORT'
        ? entryPrice * (1 - config.beOffsetPct)
        : entryPrice * (1 + config.beOffsetPct);

    // PARITY FIX: Use peakRoe if available to detect intra-candle BE trigger
    const isBeTriggered = (peakRoe !== undefined && peakRoe >= config.beTriggerRoe) || roe >= config.beTriggerRoe;

    // Check if SL is already at or better than BE
    const slIsAtBe = currentSlPrice && (
        positionSide === 'SHORT' ? currentSlPrice <= bePrice : currentSlPrice >= bePrice
    );

    if (isBeTriggered && !slIsAtBe) {
        return { type: 'MOVE_SL_BE', price: bePrice };
    }

    // 4. Standard Price-based Trailing (Legacy/Fallback)
    // Only trail if we are in profit (better than entry)
    const isInProfit = positionSide === 'SHORT'
        ? currentPrice < entryPrice
        : currentPrice > entryPrice;

    // PARITY FIX: Only trail if BE has been triggered (ROE > 10%)
    if (isInProfit && (isBeTriggered || slIsAtBe) && !config.trailingActivationRoe) {

        let trailingSlPrice = 0;
        if (config.useAtrTrailing && config.atrMultiplier && atrValue && atrValue > 0) {
            const trailingDistance = atrValue * config.atrMultiplier;
            trailingSlPrice = positionSide === 'SHORT'
                ? peakPrice + trailingDistance
                : peakPrice - trailingDistance;
        } else {
            trailingSlPrice = positionSide === 'SHORT'
                ? peakPrice * (1 + config.trailingDev)
                : peakPrice * (1 - config.trailingDev);
        }

        // Check if trailing SL is tighter than current SL
        const isTighter = currentSlPrice ? (
            positionSide === 'SHORT'
                ? trailingSlPrice < currentSlPrice
                : trailingSlPrice > currentSlPrice
        ) : true;

        // PARITY FIX: Check if trailing SL is hit by current price
        const wouldExecuteNow = positionSide === 'SHORT'
            ? currentPrice >= trailingSlPrice
            : currentPrice <= trailingSlPrice;

        if (wouldExecuteNow) {
            return { type: 'CLOSE_MARKET', reason: 'TRAILING' };
        }

        if (isTighter) {
            return { type: 'MOVE_SL_TRAILING', price: trailingSlPrice };
        }
    }

    return { type: 'HOLD' };
}
