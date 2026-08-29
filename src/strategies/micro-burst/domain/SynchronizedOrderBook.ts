import { SynchronizedOrderBook as SharedSynchronizedOrderBook } from '../../../core/market-data/SynchronizedOrderBook';
import type { SynchronizedOrderBookDeps } from '../../../core/market-data/SynchronizedOrderBook';
import type { OrderBookDepthLevel } from './MicroBurstTypes';
import type { TemporalOrderBookObservation as TemporalBookSnapshot } from '../../../app/ports/MarketData';

export type { SynchronizedOrderBookDeps } from '../../../core/market-data/SynchronizedOrderBook';

/** Compatibility surface for Micro Burst while the shared book is adopted. */
export class SynchronizedOrderBook extends SharedSynchronizedOrderBook {
  public getSnapshotForPressure():
    | {
        bidDepth: OrderBookDepthLevel[];
        askDepth: OrderBookDepthLevel[];
        observedAtMs: number;
        status: 'HEALTHY';
        lastUpdateId: number;
        temporalHistory: TemporalBookSnapshot[];
      }
    | undefined {
    return this.getSnapshot() as
      | {
          bidDepth: OrderBookDepthLevel[];
          askDepth: OrderBookDepthLevel[];
          observedAtMs: number;
          status: 'HEALTHY';
          lastUpdateId: number;
          temporalHistory: TemporalBookSnapshot[];
        }
      | undefined;
  }
}
