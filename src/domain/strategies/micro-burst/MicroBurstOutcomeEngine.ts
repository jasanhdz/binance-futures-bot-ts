// ── M3 Prospective Outcome Engine ──────────────────────────
// Pure domain functions. No I/O. No wall-clock reads.
// All computations receive injected clock or explicit timestamps.
// ───────────────────────────────────────────────────────────

import { Side } from '../../types';
import {
  ShadowSignalSnapshot,
  EntryPriceModel,
  EntryPriceAssumption,
  CostScenario,
  HorizonOutcome,
  BarrierOutcome,
  DynamicExitOutcome,
  CounterfactualExitReason,
  PendingOutcome,
} from './MicroBurstOutcomeTypes';
import {
  MicroBurstConfig,
  MicroBurstExitContext,
  defaultMicroBurstConfig,
} from './MicroBurstTypes';
import { evaluateMicroBurstExit } from './MicroBurstExitPolicy';
import { decimalReturnToBps } from './MicroBurstUnits';

// ── Constants ──────────────────────────────────────────────

export const OUTCOME_HORIZONS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

const BPS_PER_UNIT = 10_000;

// ── Side-Aware Return ──────────────────────────────────────

export function sideAwareReturnBps(entryPrice: number, currentPrice: number, side: Side): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || entryPrice <= 0 || currentPrice <= 0) {
    return Number.NaN;
  }
  const signedReturn =
    side === 'LONG'
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;
  return signedReturn * BPS_PER_UNIT;
}

// ── Entry Price Models ─────────────────────────────────────

export function computeEntryModels(
  signal: ShadowSignalSnapshot,
  priceHistory: Array<{ eventTime: number; price: number }>,
): EntryPriceAssumption[] {
  const models: EntryPriceAssumption[] = [];

  // A. SIGNAL_PRICE: entry at the market/reference price frozen at T0
  models.push({ model: 'SIGNAL_PRICE', entryPrice: signal.marketPriceAtSignal });

  // B. NEXT_TRADE: first valid trade after signalAtMs
  const nextTrade = priceHistory.find((t) => t.eventTime > signal.signalAtMs && Number.isFinite(t.price) && t.price > 0);
  if (nextTrade) {
    models.push({ model: 'NEXT_TRADE', entryPrice: nextTrade.price });
  }

  // C. CONSERVATIVE_SLIPPAGE: signal price + adverse slippage buffer
  const slippageBufferBps = 5; // 0.5 bps conservative
  const slippageDirection = signal.side === 'LONG' ? 1 : -1;
  const slippagePrice = signal.marketPriceAtSignal * (1 + (slippageDirection * slippageBufferBps) / BPS_PER_UNIT);
  models.push({ model: 'CONSERVATIVE_SLIPPAGE', entryPrice: slippagePrice });

  return models;
}

// ── Compute all entry models from price history ────────────

export function resolveEntryModels(
  signal: ShadowSignalSnapshot,
  priceHistory: Array<{ eventTime: number; price: number }>,
): EntryPriceAssumption[] {
  return computeEntryModels(signal, priceHistory);
}

// ── Horizon MFE/MAE/Return ─────────────────────────────────

export function computeHorizonOutcome(
  signal: ShadowSignalSnapshot,
  entryPrice: number,
  priceHistory: Array<{ eventTime: number; price: number }>,
  horizonMs: number,
): HorizonOutcome {
  const side = signal.side;
  const t0 = signal.signalAtMs;
  const horizonEnd = t0 + horizonMs;

  // Filter trades within this horizon window
  const horizonTrades = priceHistory.filter(
    (t) => t.eventTime > t0 && t.eventTime <= horizonEnd && Number.isFinite(t.price) && t.price > 0,
  );

  if (horizonTrades.length === 0) {
    return {
      horizonMs,
      mfeBps: 0,
      maeBps: 0,
      finalReturnBps: 0,
      timeToMfeMs: 0,
      timeToMaeMs: 0,
      stopTouched: false,
      targetTouched: false,
      barrierOutcome: 'NEITHER',
      firstTouchAtMs: null,
      priceAtHorizon: null,
      tradeCount: 0,
    };
  }

  let mfeBps = 0;
  let maeBps = 0;
  let timeToMfeMs = 0;
  let timeToMaeMs = 0;
  let stopTouched = false;
  let targetTouched = false;
  let firstStopTouchAt: number | null = null;
  let firstTargetTouchAt: number | null = null;

  for (const trade of horizonTrades) {
    const retBps = sideAwareReturnBps(entryPrice, trade.price, side);

    // MFE (max favorable)
    if (retBps > mfeBps) {
      mfeBps = retBps;
      timeToMfeMs = trade.eventTime - t0;
    }

    // MAE (max adverse)
    if (retBps < -maeBps) {
      maeBps = -retBps;
      timeToMaeMs = trade.eventTime - t0;
    }

    // Stop touch detection
    if (side === 'LONG') {
      if (trade.price <= signal.structuralStopPrice) {
        stopTouched = true;
        if (firstStopTouchAt === null) firstStopTouchAt = trade.eventTime;
      }
      if (trade.price >= signal.destinationPrice) {
        targetTouched = true;
        if (firstTargetTouchAt === null) firstTargetTouchAt = trade.eventTime;
      }
    } else {
      if (trade.price >= signal.structuralStopPrice) {
        stopTouched = true;
        if (firstStopTouchAt === null) firstStopTouchAt = trade.eventTime;
      }
      if (trade.price <= signal.destinationPrice) {
        targetTouched = true;
        if (firstTargetTouchAt === null) firstTargetTouchAt = trade.eventTime;
      }
    }
  }

  // Last trade price at horizon
  const lastTrade = horizonTrades[horizonTrades.length - 1];
  const finalReturnBps = sideAwareReturnBps(entryPrice, lastTrade.price, side);

  // Barrier outcome with temporal ordering
  let barrierOutcome: BarrierOutcome = 'NEITHER';
  let firstTouchAtMs: number | null = null;

  if (stopTouched && targetTouched) {
    if (firstStopTouchAt !== null && firstTargetTouchAt !== null) {
      if (firstStopTouchAt < firstTargetTouchAt) {
        barrierOutcome = 'STOP_FIRST';
        firstTouchAtMs = firstStopTouchAt;
      } else if (firstTargetTouchAt < firstStopTouchAt) {
        barrierOutcome = 'TARGET_FIRST';
        firstTouchAtMs = firstTargetTouchAt;
      } else {
        barrierOutcome = 'AMBIGUOUS_SAME_INTERVAL';
        firstTouchAtMs = firstStopTouchAt;
      }
    } else {
      barrierOutcome = 'AMBIGUOUS_SAME_INTERVAL';
    }
  } else if (stopTouched) {
    barrierOutcome = 'STOP_FIRST';
    firstTouchAtMs = firstStopTouchAt;
  } else if (targetTouched) {
    barrierOutcome = 'TARGET_FIRST';
    firstTouchAtMs = firstTargetTouchAt;
  }

  return {
    horizonMs,
    mfeBps,
    maeBps,
    finalReturnBps,
    timeToMfeMs,
    timeToMaeMs,
    stopTouched,
    targetTouched,
    barrierOutcome,
    firstTouchAtMs,
    priceAtHorizon: lastTrade.price,
    tradeCount: horizonTrades.length,
  };
}

// ── All Horizons ───────────────────────────────────────────

export function computeAllHorizons(
  signal: ShadowSignalSnapshot,
  entryPrice: number,
  priceHistory: Array<{ eventTime: number; price: number }>,
): Record<number, HorizonOutcome> {
  const result: Record<number, HorizonOutcome> = {};
  for (const h of OUTCOME_HORIZONS_MS) {
    result[h] = computeHorizonOutcome(signal, entryPrice, priceHistory, h);
  }
  return result;
}

// ── Aggregate Barrier Outcome ──────────────────────────────

export function aggregateBarrierOutcome(
  horizons: Record<number, HorizonOutcome>,
): BarrierOutcome {
  const outcomes = Object.values(horizons);
  const targetFirst = outcomes.some((h) => h.barrierOutcome === 'TARGET_FIRST');
  const stopFirst = outcomes.some((h) => h.barrierOutcome === 'STOP_FIRST');
  const ambiguous = outcomes.some((h) => h.barrierOutcome === 'AMBIGUOUS_SAME_INTERVAL');

  if (targetFirst && stopFirst) return 'AMBIGUOUS_SAME_INTERVAL';
  if (ambiguous) return 'AMBIGUOUS_SAME_INTERVAL';
  if (targetFirst) return 'TARGET_FIRST';
  if (stopFirst) return 'STOP_FIRST';
  return 'NEITHER';
}

// ── Cost Scenarios ─────────────────────────────────────────

export function computeCostScenarios(
  grossBps: number,
  scenarios: CostScenario[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const s of scenarios) {
    result[s.label] = grossBps - s.feeBps - s.slippageBps;
  }
  return result;
}

// ── Dynamic Exit Simulation ────────────────────────────────
// Simulates the MicroBurst exit policy against price history.
// Uses the EXISTING evaluateMicroBurstExit — no new logic.

export function simulateDynamicExit(
  signal: ShadowSignalSnapshot,
  entryPrice: number,
  priceHistory: Array<{ eventTime: number; price: number }>,
  config: MicroBurstConfig = defaultMicroBurstConfig(),
): DynamicExitOutcome | null {
  const side = signal.side;
  const t0 = signal.signalAtMs;

  // Build a price trajectory sorted by time
  const trajectory = priceHistory
    .filter((t) => t.eventTime > t0 && Number.isFinite(t.price) && t.price > 0)
    .sort((a, b) => a.eventTime - b.eventTime);

  if (trajectory.length === 0) return null;

  let peakPrice = entryPrice;
  let troughPrice = entryPrice;
  let currentStopPrice: number | null = null;
  let breakEvenActivated = false;
  let trailingActivated = false;

  for (const trade of trajectory) {
    const currentPrice = trade.price;
    const timeInTradeMs = trade.eventTime - t0;

    // Update peak/trough
    if (side === 'LONG') {
      if (currentPrice > peakPrice) peakPrice = currentPrice;
      if (currentPrice < troughPrice) troughPrice = currentPrice;
    } else {
      if (currentPrice > peakPrice) peakPrice = currentPrice;
      if (currentPrice < troughPrice) troughPrice = currentPrice;
    }

    // Build exit context
    const priceReturn = side === 'LONG'
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;
    const unrealizedRoe = priceReturn * signal.leverage;

    const exitContext: MicroBurstExitContext = {
      unrealizedRoe,
      priceReturn,
      currentPrice,
      entryPrice,
      peakPrice,
      troughPrice,
      structuralInvalidationPrice: signal.structuralStopPrice,
      destinationPrice: signal.destinationPrice,
      currentStopPrice: currentStopPrice ?? signal.structuralStopPrice,
      timeInTradeMs,
      momentumDecayFlag: false,
      anomalyExitFlag: false,
      currentBookPressure: null,
      currentBtcContext: null,
      leverage: signal.leverage,
    };

    const decision = evaluateMicroBurstExit(exitContext, config, side);

    if (decision.action === 'MOVE_STOP' && decision.reason === 'BREAK_EVEN') {
      currentStopPrice = decision.requestedStopPrice ?? entryPrice;
      breakEvenActivated = true;
      continue;
    }

    if (decision.action === 'CLOSE_MARKET') {
      const grossBps = sideAwareReturnBps(entryPrice, currentPrice, side);
      return {
        counterfactualExitReason: decision.reason as CounterfactualExitReason,
        counterfactualExitAtMs: trade.eventTime,
        counterfactualExitPrice: currentPrice,
        counterfactualGrossBps: grossBps,
        counterfactualNetBps: grossBps, // costs applied separately
      };
    }

    // Check trailing activation
    if (!trailingActivated) {
      const favorableBps = side === 'LONG'
        ? decimalReturnToBps((peakPrice - entryPrice) / entryPrice)
        : decimalReturnToBps((entryPrice - troughPrice) / entryPrice);
      if (favorableBps >= config.exitTrailingActivationBps) {
        trailingActivated = true;
      }
    }
  }

  // Still holding at end of trajectory
  const lastPrice = trajectory[trajectory.length - 1].price;
  const grossBps = sideAwareReturnBps(entryPrice, lastPrice, side);
  return {
    counterfactualExitReason: 'HOLD_AT_HORIZON',
    counterfactualExitAtMs: trajectory[trajectory.length - 1].eventTime,
    counterfactualExitPrice: lastPrice,
    counterfactualGrossBps: grossBps,
    counterfactualNetBps: grossBps,
  };
}

// ── Snapshot from Evaluation Result ────────────────────────

export function freezeSignalSnapshot(params: {
  shadowSignalId: string;
  strategyId: string;
  strategyVersion: string;
  codeCommitSha: string;
  configHash: string;
  symbol: string;
  side: Side;
  signalAtMs: number;
  marketPriceAtSignal: number;
  referencePriceSource: string;
  structuralStopPrice: number;
  destinationPrice: number;
  support: number | null;
  resistance: number | null;
  roomToTargetBps: number;
  riskToInvalidationBps: number;
  rewardRisk: number;
  momentum: ShadowSignalSnapshot['momentum'];
  book: ShadowSignalSnapshot['book'];
  tradeFlow: ShadowSignalSnapshot['tradeFlow'];
  btc: ShadowSignalSnapshot['btc'];
  confidence: number;
  leverageTier: string;
  leverage: number;
  positionFraction: number;
  microRegime: string;
}): ShadowSignalSnapshot {
  return { ...params };
}

// ── Pending Outcome Initialization ─────────────────────────

export function createPendingOutcome(
  signal: ShadowSignalSnapshot,
  episodeId: string,
): PendingOutcome {
  return {
    signal,
    episodeId,
    entryModels: [],
    priceHistory: [],
    nextTradeResolved: false,
    pendingHorizons: new Set(OUTCOME_HORIZONS_MS),
    completedHorizons: new Map(),
    peakPrice: signal.marketPriceAtSignal,
    troughPrice: signal.marketPriceAtSignal,
    createdAtMs: signal.signalAtMs,
  };
}
