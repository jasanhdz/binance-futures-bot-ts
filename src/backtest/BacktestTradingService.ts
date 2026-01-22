import { TradingService, TradingServiceDeps, TradingServiceConfig } from '../app/services/TradingService';

export class BacktestTradingService extends TradingService {
    constructor(deps: TradingServiceDeps, config: TradingServiceConfig) {
        super(deps, config);
    }

    /**
     * Expose processSymbol for backtesting tick-by-tick execution
     * Includes Time Sentinel check using CANDLE time (not system time)
     */
    public async tick(symbol: string): Promise<void> {
        const { exchange, logger } = this['deps']; // Access protected deps via string index or change visibility

        // Get current candle time
        const candle = await exchange.getLastCandle(symbol);
        if (!candle) return;

        const timestamp = new Date(candle.openTime);
        const hour = timestamp.getUTCHours();
        const day = timestamp.getUTCDay(); // 0=Sun, 1=Mon...

        // Forbidden Hours (UTC) from backtest
        const FORBIDDEN_HOURS = [1, 4, 5, 10, 13, 18, 19, 23];

        // Forbidden Days (Tuesday = 2)
        const isForbidden = (day === 2) || FORBIDDEN_HOURS.includes(hour);

        // DEBUG: Trade 3 Investigation
        if (candle.openTime === 1737324000000 || candle.timestamp === 1737324000000) {
            console.log(`[DEBUG Trade 3 FOUND] openTime: ${candle.openTime}, timestamp: ${candle.timestamp}, Hour: ${hour}, Day: ${day}, isForbidden: ${isForbidden}`);
        }

        // 1. Check Sentinel (Entry Block only)
        const state = this['deps'].state.get();
        const hasPosition = state.mode !== 'IDLE';

        if (isForbidden && !hasPosition) {
            console.log(`[SENTINEL] Blocked: ${timestamp.toISOString()} (Hour ${hour})`);
            return;
        }

        // 2. Intra-Candle Simulation (PARITY FIX)
        // Python checks Low (for peak update) and High (for stop hit) within the candle.
        // TS normally only checks Close. We must simulate the price movement.
        if (hasPosition) {
            const originalClose = candle.close;
            const side = state.mode === 'SHORT_RIDE' ? 'SHORT' : 'LONG';

            // Simulation Order: Best Case -> Worst Case -> Final Close
            // SHORT: Low (Update Peak/TP) -> High (Check SL/Trailing) -> Close
            // LONG: High (Update Peak/TP) -> Low (Check SL/Trailing) -> Close
            const steps = side === 'SHORT'
                ? [candle.low, candle.high, originalClose]
                : [candle.high, candle.low, originalClose];

            for (const price of steps) {
                // Hack: Temporarily modify candle close so exchange.getPrice() returns this value
                // This allows ProfitGuardian to see the intra-candle price
                candle.close = price;

                await this.processSymbol(symbol);

                // If position closed, stop simulation
                const newState = this['deps'].state.get();
                if (newState.mode === 'IDLE') break;
            }

            // Restore original close
            candle.close = originalClose;
        } else {
            // No position: Just check entry at Close
            await this.processSymbol(symbol);
        }
    }
}
