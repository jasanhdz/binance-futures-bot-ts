/**
 * ProfitGuardian - Domain Service
 * 
 * Dynamic trailing profit protection & Break-Even logic.
 * Matches Phantom V8 Backtest logic.
 */

export interface GuardianContext {
    entryPrice: number;
    currentPrice: number;
    peakPrice: number;      // Best price seen (Lowest for SHORT, Highest for LONG)
    positionSide: 'LONG' | 'SHORT';
    leverage: number;
    peakRoe?: number;       // PARITY FIX: Track max ROE seen to trigger BE intra-candle
}

export interface GuardianConfig {
    beTriggerRoe: number;   // e.g. 0.10 (10%)
    beOffsetPct: number;    // e.g. 0.003 (0.3% to cover fees)
    trailingDev: number;    // e.g. 0.015 (1.5% deviation)
}

export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
    beTriggerRoe: 0.10,     // 10% ROE triggers BE
    beOffsetPct: 0.003,     // Secure 0.3% profit at BE
    trailingDev: 0.015      // Trail price by 1.5%
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
    const { entryPrice, currentPrice, peakPrice, positionSide, leverage, peakRoe } = ctx;

    // 1. Calculate ROE
    const roe = positionSide === 'SHORT'
        ? (entryPrice - currentPrice) / entryPrice * leverage
        : (currentPrice - entryPrice) / entryPrice * leverage;

    // 2. Break-Even Logic
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

    // 3. Price-based Trailing Logic
    // Only trail if we are in profit (better than entry)
    const isInProfit = positionSide === 'SHORT'
        ? currentPrice < entryPrice
        : currentPrice > entryPrice;

    // PARITY FIX: Only trail if BE has been triggered (ROE > 10%)
    // Python logic: "If BE activated, use trailing stop"
    if (isInProfit && (isBeTriggered || slIsAtBe)) {
        // console.log(`[GUARDIAN] Trailing Active. ROE: ${roe.toFixed(4)}, BE: ${isBeTriggered}, SL@BE: ${slIsAtBe}`);
        const trailingSlPrice = positionSide === 'SHORT'
            ? peakPrice * (1 + config.trailingDev)
            : peakPrice * (1 - config.trailingDev);

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

        // DEBUG: Trade 2 investigation
        if (Math.abs(entryPrice - 3278.93) < 0.01) {
            console.log(`[TRADE 2 DEBUG] TS: ${Date.now()} | Entry: ${entryPrice}, Peak: ${peakPrice}, Trailing SL: ${trailingSlPrice}, Current: ${currentPrice}, Would Execute: ${wouldExecuteNow}`);
        }

        if (wouldExecuteNow) {
            // PARITY FIX: If calculated SL is already hit, CLOSE IMMEDIATELY
            return { type: 'CLOSE_MARKET', reason: 'TRAILING' };
        }

        if (isTighter) {
            return { type: 'MOVE_SL_TRAILING', price: trailingSlPrice };
        }
    }

    return { type: 'HOLD' };
}
