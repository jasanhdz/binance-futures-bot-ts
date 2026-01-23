import { BacktestTradingService } from './BacktestTradingService';
import { TradingServiceDeps, TradingServiceConfig } from '../app/services/TradingService';

export class PhantomV9TradingService extends BacktestTradingService {
    constructor(deps: TradingServiceDeps, config: TradingServiceConfig) {
        super(deps, config);
    }

    /**
     * Override tick to use Phantom V9 Time Sentinel logic
     * V9 Forbidden Hours: [0, 1, 22, 23] (UTC)
     * V9 Forbidden Days: ['Tuesday'] (Day 2)
     */
    public async tick(symbol: string): Promise<void> {
        const { exchange } = this['deps'];

        // Get current candle time
        const candle = await exchange.getLastCandle(symbol);
        if (!candle) return;

        const timestamp = new Date(candle.openTime);
        const hour = timestamp.getUTCHours();
        const day = timestamp.getUTCDay(); // 0=Sun, 1=Mon...

        // V9 Time Sentinel Config
        const FORBIDDEN_HOURS = [0, 1, 22, 23];
        const isForbidden = (day === 2) || FORBIDDEN_HOURS.includes(hour);

        // 1. Check Sentinel (Entry Block only)
        const state = this['deps'].state.get();
        const hasPosition = state.mode !== 'IDLE';

        if (isForbidden && !hasPosition) {
            // console.log(`[SENTINEL V9] Blocked: ${timestamp.toISOString()} (Hour ${hour})`);
            return;
        }

        // 2. Intra-Candle Simulation (Same as BacktestTradingService)
        if (hasPosition) {
            const originalClose = candle.close;
            const side = state.mode === 'SHORT_RIDE' ? 'SHORT' : 'LONG';

            // Simulation Order: Best Case -> Worst Case -> Final Close
            const steps = side === 'SHORT'
                ? [candle.low, candle.high, originalClose]
                : [candle.high, candle.low, originalClose];

            for (const price of steps) {
                candle.close = price;
                await this.processSymbol(symbol);
                const newState = this['deps'].state.get();
                if (newState.mode === 'IDLE') break;
            }
            candle.close = originalClose;
        } else {
            await this.processSymbol(symbol);
        }
    }
}
