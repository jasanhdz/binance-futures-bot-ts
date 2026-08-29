import { Logger } from '../../../app/ports/Logger';

export type ReferencePriceSource = 'MARK_PRICE' | 'MIDPOINT' | 'BEST_BID_ASK';

export interface MicroBurstReferencePrice {
  price: number;
  source: ReferencePriceSource;
  observedAtMs: number;
  isLiveRuntime: boolean;
}

const STALE_THRESHOLD_MS = 5_000;

export interface MicroBurstReferencePriceDeps {
  getMarkPrice(symbol: string): Promise<number>;
  getDepthSnapshot?(
    symbol: string,
  ): { bidDepth: { price: number }[]; askDepth: { price: number }[] } | undefined;
  logger: Logger;
}

interface Clock {
  now(): number;
}

export class MicroBurstReferencePriceProvider {
  private lastMarkPrice = 0;
  private lastMarkPriceMs = 0;

  constructor(
    private readonly deps: MicroBurstReferencePriceDeps,
    private readonly clock: Clock,
    private readonly staleThresholdMs = STALE_THRESHOLD_MS,
  ) {}

  async pollMarkPrice(symbol: string): Promise<void> {
    try {
      const price = await this.deps.getMarkPrice(symbol);
      if (Number.isFinite(price) && price > 0) {
        this.lastMarkPrice = price;
        this.lastMarkPriceMs = this.clock.now();
      }
    } catch (err) {
      this.deps.logger.error('MicroBurst reference price poll failed', {
        symbol,
        error: String(err),
      });
    }
  }

  getReferencePrice(
    symbol: string,
    bookSnapshot?: {
      bidDepth: { price: number }[];
      askDepth: { price: number }[];
    },
  ): MicroBurstReferencePrice | undefined {
    const now = this.clock.now();

    if (bookSnapshot && bookSnapshot.bidDepth.length > 0 && bookSnapshot.askDepth.length > 0) {
      const bestBid = bookSnapshot.bidDepth[0].price;
      const bestAsk = bookSnapshot.askDepth[0].price;
      if (
        Number.isFinite(bestBid) &&
        bestBid > 0 &&
        Number.isFinite(bestAsk) &&
        bestAsk > bestBid
      ) {
        const midpoint = (bestBid + bestAsk) / 2;
        return {
          price: midpoint,
          source: 'MIDPOINT' as ReferencePriceSource,
          observedAtMs: now,
          isLiveRuntime: true,
        };
      }
    }

    if (
      this.lastMarkPrice > 0 &&
      Number.isFinite(this.lastMarkPrice) &&
      now - this.lastMarkPriceMs <= this.staleThresholdMs
    ) {
      return {
        price: this.lastMarkPrice,
        source: 'MARK_PRICE' as ReferencePriceSource,
        observedAtMs: this.lastMarkPriceMs,
        isLiveRuntime: true,
      };
    }

    return undefined;
  }
}
