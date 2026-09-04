import type { AggTradeEvent } from '../../../app/ports/MarketData';
import { analyzeBookPressure } from '../domain/MicroBurstBookPressureAnalyzer';
import type { OrderBookSnapshot } from '../domain/MicroBurstTypes';

const BPS = 10_000;
const HISTORY_MS = 15_000;
const TAKER_WINDOW_MS = 5_000;
const QUALITY_WINDOW_MS = 10_000;
const INTENSITY_WINDOW_MS = 1_000;

export interface MicroBurstFastTradeReader {
  getRecent(maxAgeMs?: number): ReadonlyArray<AggTradeEvent>;
  getTakerFlow(maxAgeMs?: number): {
    buyVolume: number;
    sellVolume: number;
    netTakerVolume: number;
    tradeCount: number;
    requestedWindowMs: number;
    observedWindowMs: number;
    observedSampleCount: number;
    eventWatermarkMs: number | null;
    capacityTruncated: boolean;
    coverageStartedAtMs: number | null;
    windowComplete: boolean;
    gapFree: boolean;
  };
}

export interface MicroBurstFastBookReader {
  getSnapshot(): OrderBookSnapshot | undefined;
}

export interface MicroBurstFastMarketSnapshot {
  readonly schemaVersion: 1;
  readonly symbol: string;
  readonly observedAtMs: number;
  readonly lastPrice: number | null;
  readonly lastTradeAtMs: number | null;
  readonly returnsBps: {
    readonly ms250: number | null;
    readonly s1: number | null;
    readonly s3: number | null;
    readonly s5: number | null;
    readonly s10: number | null;
  };
  /** Current 1 s average velocity, in bps/second. */
  readonly velocityBpsPerSecond: number | null;
  /** Difference between 1 s and 3 s average velocity divided by two seconds. */
  readonly accelerationBpsPerSecond2: number | null;
  readonly tradeIntensityPerSecond: number | null;
  readonly buyTakerVolume: number;
  readonly sellTakerVolume: number;
  readonly takerImbalance: number | null;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly midPrice: number | null;
  readonly spreadBps: number | null;
  readonly signedBookImbalance: number | null;
  readonly bookImbalanceSlope: number | null;
  readonly temporalSweepDetected: boolean | null;
  readonly temporalAbsorptionDetected: boolean | null;
  readonly dataQuality: {
    readonly tradeAgeMs: number | null;
    readonly bookAgeMs: number | null;
    readonly bookStatus: string;
    readonly gapFree: boolean;
    readonly windowComplete: boolean;
    readonly capacityTruncated: boolean;
    readonly coverageStartedAtMs: number | null;
    readonly eventWatermarkMs: number | null;
  };
}

interface Clock {
  now(): number;
}

export interface MicroBurstFastMarketStateDeps {
  readonly trades: MicroBurstFastTradeReader;
  readonly book: MicroBurstFastBookReader;
  readonly clock: Clock;
}

/**
 * Pure read-only view over runtime-owned in-memory aggTrade and synchronized-book state.
 * It deliberately owns no subscriptions, timers, REST clients, or exchange mutation ports.
 */
export class MicroBurstFastMarketState {
  constructor(
    private readonly symbol: string,
    private readonly deps: MicroBurstFastMarketStateDeps,
  ) {}

  read(): MicroBurstFastMarketSnapshot {
    const now = this.deps.clock.now();
    const trades = this.deps.trades
      .getRecent(HISTORY_MS)
      .filter(validTrade)
      .filter((trade) => trade.eventTime <= now)
      .slice()
      .sort((left, right) => left.eventTime - right.eventTime);
    const latest = trades[trades.length - 1] ?? null;

    const return250 = returnAtHorizonBps(trades, latest, 250);
    const return1s = returnAtHorizonBps(trades, latest, 1_000);
    const return3s = returnAtHorizonBps(trades, latest, 3_000);
    const return5s = returnAtHorizonBps(trades, latest, 5_000);
    const return10s = returnAtHorizonBps(trades, latest, 10_000);

    const velocity1s = return1s;
    const velocity3s = return3s === null ? null : return3s / 3;
    const acceleration =
      velocity1s === null || velocity3s === null ? null : (velocity1s - velocity3s) / 2;

    const causalTakerTrades = latest
      ? trades.filter((trade) => trade.eventTime > latest.eventTime - TAKER_WINDOW_MS)
      : [];
    let buyTakerVolume = 0;
    let sellTakerVolume = 0;
    for (const trade of causalTakerTrades) {
      if (trade.isBuyerMaker) sellTakerVolume += trade.quantity;
      else buyTakerVolume += trade.quantity;
    }
    const takerTotal = buyTakerVolume + sellTakerVolume;
    const takerImbalance =
      takerTotal > 0 ? (buyTakerVolume - sellTakerVolume) / takerTotal : null;
    const recentTradeCount = latest
      ? trades.filter((trade) => trade.eventTime > latest.eventTime - INTENSITY_WINDOW_MS).length
      : 0;
    const tradeIntensityPerSecond = latest ? recentTradeCount : null;

    const flowQuality = this.deps.trades.getTakerFlow(QUALITY_WINDOW_MS);
    const bookSnapshot = this.deps.book.getSnapshot();
    const bookPressure = analyzeBookPressure(bookSnapshot, now, undefined, bookSnapshot?.temporalHistory);
    const bestBid = finitePositive(bookSnapshot?.bidDepth[0]?.price);
    const bestAsk = finitePositive(bookSnapshot?.askDepth[0]?.price);
    const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
    const spreadBps =
      bestBid !== null && bestAsk !== null && midPrice !== null && bestAsk >= bestBid
        ? ((bestAsk - bestBid) / midPrice) * BPS
        : null;

    return Object.freeze({
      schemaVersion: 1 as const,
      symbol: this.symbol,
      observedAtMs: now,
      lastPrice: latest?.price ?? null,
      lastTradeAtMs: latest?.eventTime ?? null,
      returnsBps: Object.freeze({
        ms250: return250,
        s1: return1s,
        s3: return3s,
        s5: return5s,
        s10: return10s,
      }),
      velocityBpsPerSecond: velocity1s,
      accelerationBpsPerSecond2: acceleration,
      tradeIntensityPerSecond,
      buyTakerVolume,
      sellTakerVolume,
      takerImbalance,
      bestBid,
      bestAsk,
      midPrice,
      spreadBps,
      signedBookImbalance:
        bookPressure.status === 'UNAVAILABLE' ? null : bookPressure.signedTopOfBookImbalance,
      bookImbalanceSlope:
        bookPressure.status === 'UNAVAILABLE' ? null : bookPressure.imbalanceSlope,
      temporalSweepDetected:
        bookPressure.status === 'UNAVAILABLE' ? null : bookPressure.temporalSweepDetected,
      temporalAbsorptionDetected:
        bookPressure.status === 'UNAVAILABLE' ? null : bookPressure.temporalAbsorptionDetected,
      dataQuality: Object.freeze({
        tradeAgeMs: latest ? now - latest.eventTime : null,
        bookAgeMs: bookSnapshot ? now - bookSnapshot.observedAtMs : null,
        bookStatus: bookPressure.status,
        gapFree: flowQuality.gapFree,
        windowComplete: flowQuality.windowComplete,
        capacityTruncated: flowQuality.capacityTruncated,
        coverageStartedAtMs: flowQuality.coverageStartedAtMs,
        eventWatermarkMs: flowQuality.eventWatermarkMs,
      }),
    });
  }
}

function validTrade(trade: AggTradeEvent): boolean {
  return (
    Number.isFinite(trade.eventTime) &&
    trade.eventTime > 0 &&
    Number.isFinite(trade.price) &&
    trade.price > 0 &&
    Number.isFinite(trade.quantity) &&
    trade.quantity >= 0
  );
}

function finitePositive(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function anchorToleranceMs(horizonMs: number): number {
  return Math.max(250, Math.min(2_000, horizonMs * 0.2));
}

/**
 * Uses the last observation at or before latest-horizon. A stale anchor is rejected instead
 * of silently pretending an old price was observed at the requested boundary.
 */
function returnAtHorizonBps(
  trades: readonly AggTradeEvent[],
  latest: AggTradeEvent | null,
  horizonMs: number,
): number | null {
  if (!latest) return null;
  const targetAtMs = latest.eventTime - horizonMs;
  let anchor: AggTradeEvent | null = null;
  for (let index = trades.length - 1; index >= 0; index--) {
    const candidate = trades[index];
    if (candidate.eventTime <= targetAtMs) {
      anchor = candidate;
      break;
    }
  }
  if (!anchor || targetAtMs - anchor.eventTime > anchorToleranceMs(horizonMs)) return null;
  return ((latest.price - anchor.price) / anchor.price) * BPS;
}
