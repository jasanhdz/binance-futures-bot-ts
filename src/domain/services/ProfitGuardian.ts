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
    const { entryPrice, currentPrice, peakPrice, positionSide, leverage } = ctx;

    // 1. Calculate ROE
    const roe = positionSide === 'SHORT'
        ? (entryPrice - currentPrice) / entryPrice * leverage
        : (currentPrice - entryPrice) / entryPrice * leverage;

    // 2. Break-Even Logic
    // If ROE > Trigger AND we haven't moved SL yet (approx check)
    const bePrice = positionSide === 'SHORT'
        ? entryPrice * (1 - config.beOffsetPct)
        : entryPrice * (1 + config.beOffsetPct);

    const isBeTriggered = roe >= config.beTriggerRoe;

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

    if (isInProfit) {
        const trailingSlPrice = positionSide === 'SHORT'
            ? peakPrice * (1 + config.trailingDev)
            : peakPrice * (1 - config.trailingDev);

        // Check if trailing SL is tighter than current SL
        const isTighter = currentSlPrice ? (
            positionSide === 'SHORT'
                ? trailingSlPrice < currentSlPrice
                : trailingSlPrice > currentSlPrice
        ) : true;

        // Also ensure trailing SL is not worse than current price (don't execute immediately)
        const wouldExecuteNow = positionSide === 'SHORT'
            ? currentPrice >= trailingSlPrice
            : currentPrice <= trailingSlPrice;

        if (isTighter && !wouldExecuteNow) {
            return { type: 'MOVE_SL_TRAILING', price: trailingSlPrice };
        }
    }

    return { type: 'HOLD' };
}
