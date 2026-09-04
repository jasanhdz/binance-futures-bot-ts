import type { AggTradeEvent } from '../../../app/ports/MarketData';
import {
  DEFAULT_COST_SCENARIOS,
} from './MicroBurstOutcomeTypes';
import {
  MICRO_OPPORTUNITY_HORIZONS_MS,
  type MicroOpportunityHorizonLabel,
  type MicroOpportunityHorizonMs,
  type MicroOpportunityLabeledSample,
  type MicroOpportunityResearchSample,
  type OpportunityEconomicOutcome,
  type OpportunityOrientationOutcome,
} from './MicroOpportunityTypes';

const FINAL_PRICE_MAX_STALENESS_MS = 1_000;

export interface MicroOpportunityFutureWindow {
  readonly trades: readonly AggTradeEvent[];
  /** Archive/feed watermark proving observation coverage reached this time. */
  readonly watermarkMs: number;
  readonly hasAggTradeGap: (fromMs: number, toMs: number) => boolean;
}

export function labelMicroOpportunitySample(
  sample: MicroOpportunityResearchSample,
  future: MicroOpportunityFutureWindow,
): MicroOpportunityLabeledSample {
  const labels = {} as Record<MicroOpportunityHorizonMs, MicroOpportunityHorizonLabel>;
  for (const horizonMs of MICRO_OPPORTUNITY_HORIZONS_MS) {
    labels[horizonMs] = labelHorizon(sample, future, horizonMs);
  }
  return Object.freeze({ sample, labels: Object.freeze(labels) });
}

function labelHorizon(
  sample: MicroOpportunityResearchSample,
  future: MicroOpportunityFutureWindow,
  horizonMs: MicroOpportunityHorizonMs,
): MicroOpportunityHorizonLabel {
  const fromMs = sample.sampledAtMs;
  const toMs = fromMs + horizonMs;
  if (future.watermarkMs < toMs)
    return invalid(horizonMs, 'INSUFFICIENT_FUTURE_WATERMARK');
  if (future.hasAggTradeGap(fromMs, toMs)) return invalid(horizonMs, 'AGG_TRADE_GAP');

  const trades = future.trades
    .filter(validTrade)
    .filter((trade) => trade.eventTime > fromMs && trade.eventTime <= toMs)
    .slice()
    .sort((left, right) => left.eventTime - right.eventTime);
  if (trades.length === 0) return invalid(horizonMs, 'NO_POST_T0_TRADES');

  const finalTrade = trades[trades.length - 1];
  if (toMs - finalTrade.eventTime > FINAL_PRICE_MAX_STALENESS_MS)
    return invalid(horizonMs, 'STALE_FINAL_PRICE', trades.length);

  const long = orientation(sample.referencePrice, trades, 'LONG', fromMs);
  const short = orientation(sample.referencePrice, trades, 'SHORT', fromMs);
  return {
    horizonMs,
    valid: true,
    invalidReason: null,
    tradeCount: trades.length,
    long,
    short,
    longEconomic: economic(long),
    shortEconomic: economic(short),
  };
}

function orientation(
  entryPrice: number,
  trades: readonly AggTradeEvent[],
  side: 'LONG' | 'SHORT',
  t0: number,
): OpportunityOrientationOutcome {
  let mfeBps = 0;
  let maeBps = 0;
  let timeToMfeMs = 0;
  let timeToMaeMs = 0;
  for (const trade of trades) {
    const rawBps = ((trade.price - entryPrice) / entryPrice) * 10_000;
    const sideAwareBps = side === 'LONG' ? rawBps : -rawBps;
    if (sideAwareBps > mfeBps) {
      mfeBps = sideAwareBps;
      timeToMfeMs = trade.eventTime - t0;
    }
    if (-sideAwareBps > maeBps) {
      maeBps = -sideAwareBps;
      timeToMaeMs = trade.eventTime - t0;
    }
  }
  const finalRawBps = ((trades[trades.length - 1].price - entryPrice) / entryPrice) * 10_000;
  return {
    mfeBps,
    maeBps,
    finalReturnBps: side === 'LONG' ? finalRawBps : -finalRawBps,
    timeToMfeMs,
    timeToMaeMs,
  };
}

function economic(outcome: OpportunityOrientationOutcome): OpportunityEconomicOutcome {
  const netFavorableBps = {} as OpportunityEconomicOutcome['netFavorableBps'];
  const netPositive = {} as OpportunityEconomicOutcome['netPositive'];
  const mutableNet = netFavorableBps as Record<string, number>;
  const mutablePositive = netPositive as Record<string, boolean>;
  for (const scenario of DEFAULT_COST_SCENARIOS) {
    mutableNet[scenario.label] = outcome.mfeBps - scenario.feeBps - scenario.slippageBps;
    mutablePositive[scenario.label] = mutableNet[scenario.label] > 0;
  }
  return {
    netFavorableBps,
    netPositive,
    mfeMaeAsymmetryBps: outcome.mfeBps - outcome.maeBps,
  };
}

function invalid(
  horizonMs: MicroOpportunityHorizonMs,
  invalidReason: string,
  tradeCount = 0,
): MicroOpportunityHorizonLabel {
  return {
    horizonMs,
    valid: false,
    invalidReason,
    tradeCount,
    long: null,
    short: null,
    longEconomic: null,
    shortEconomic: null,
  };
}

function validTrade(trade: AggTradeEvent): boolean {
  return (
    Number.isFinite(trade.eventTime) &&
    Number.isFinite(trade.price) &&
    trade.eventTime > 0 &&
    trade.price > 0
  );
}
