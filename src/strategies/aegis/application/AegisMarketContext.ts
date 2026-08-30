import type { Candle } from '../../../core/types';
import type { OrderBookHealth } from '../../../app/ports/MarketData';
import type { SharedCandleSource, SharedCandleStatus } from '../../../core/market-data/CandleDataPlane';

export const AEGIS_MARKET_CONTEXT_VERSION = 'AEGIS_MARKET_CONTEXT_V1' as const;

/** Frozen universe consumed by the current 83-feature Python brain. */
export const AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS = [
  'ETHUSDT',
  'BTCUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'SUIUSDT',
  'LTCUSDT',
] as const;

export interface AegisCandleSeriesV1 {
  readonly source: SharedCandleSource;
  readonly status: SharedCandleStatus;
  readonly observedAtMs: number;
  readonly ageMs: number;
  readonly websocketObservedAtMs?: number;
  readonly restFallbackCount: number;
  readonly candles: readonly Candle[];
}

export interface AegisMarketContextV1 {
  readonly version: typeof AEGIS_MARKET_CONTEXT_VERSION;
  readonly symbol: string;
  readonly capturedAtMs: number;
  readonly source: 'SHARED_MARKET_DATA_RUNTIME';
  readonly status: 'FRESH';
  readonly quote: {
    readonly bestBid: number;
    readonly bestAsk: number;
    readonly midPrice: number;
    readonly spreadBps: number;
    readonly observedAtMs: number;
    readonly ageMs: number;
  };
  readonly orderBook: {
    readonly health: OrderBookHealth;
    readonly observedAtMs: number;
    readonly ageMs: number;
    readonly lastUpdateId: number;
    readonly bids: readonly { readonly price: number; readonly qty: number }[];
    readonly asks: readonly { readonly price: number; readonly qty: number }[];
  };
  readonly aggTrades: {
    readonly windowMs: number;
    readonly observedAtMs: number;
    readonly ageMs: number;
    readonly gapFree: boolean;
    readonly windowComplete: boolean;
    readonly tradeCount: number;
    readonly buyVolume: number;
    readonly sellVolume: number;
    readonly netTakerVolume: number;
  };
  /** Current-symbol convenience view retained for diagnostics. */
  readonly candles5m: AegisCandleSeriesV1;
  /** Exact 11-symbol candle universe required by the current Python feature pipeline. */
  readonly universeCandles5m: Readonly<Record<string, AegisCandleSeriesV1>>;
  readonly liquidity: {
    readonly stress: number;
    readonly status: 'FRESH';
    readonly observedAtMs: number;
    readonly ageMs: number;
    readonly inputVersion: string;
  };
}

/** Aegis prediction input transported to the Python service. */
export interface AegisPredictionInputV1 {
  readonly symbol: string;
  readonly marketContext?: AegisMarketContextV1;
}
