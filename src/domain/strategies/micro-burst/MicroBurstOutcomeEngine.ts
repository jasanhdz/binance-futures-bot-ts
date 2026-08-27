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
  DEFAULT_COST_SCENARIOS,
  HorizonOutcome,
  BarrierOutcome,
  DynamicExitOutcome,
  CounterfactualExitReason,
  PendingOutcome,
  EntryModelOutcome,
  CostComponents,
} from './MicroBurstOutcomeTypes';
import { MicroBurstConfig, defaultMicroBurstConfig } from './MicroBurstTypes';

// ── Constants ──────────────────────────────────────────────

export const OUTCOME_HORIZONS_MS: readonly number[] = [
  15_000, 30_000, 60_000, 120_000, 300_000,
] as const;
export const CONSERVATIVE_SLIPPAGE_BPS = 5;

const BPS_PER_UNIT = 10_000;

// ── Side-Aware Return ──────────────────────────────────────

export function sideAwareReturnBps(entryPrice: number, currentPrice: number, side: Side): number {
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(currentPrice) ||
    entryPrice <= 0 ||
    currentPrice <= 0
  ) {
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
  models.push({
    model: 'SIGNAL_PRICE',
    entryPrice: signal.marketPriceAtSignal,
    available: true,
    slippageBps: 0,
  });

  // B. NEXT_TRADE: first valid trade after signalAtMs
  const nextTrade = priceHistory.find(
    (t) => t.eventTime > signal.signalAtMs && Number.isFinite(t.price) && t.price > 0,
  );
  if (nextTrade) {
    models.push({
      model: 'NEXT_TRADE',
      entryPrice: nextTrade.price,
      available: true,
      slippageBps: 0,
    });
  } else {
    models.push({ model: 'NEXT_TRADE', entryPrice: null, available: false, slippageBps: 0 });
  }

  // C. CONSERVATIVE_SLIPPAGE: signal price + adverse slippage buffer
  const slippageBufferBps = CONSERVATIVE_SLIPPAGE_BPS;
  const slippageDirection = signal.side === 'LONG' ? 1 : -1;
  const slippagePrice =
    signal.marketPriceAtSignal * (1 + (slippageDirection * slippageBufferBps) / BPS_PER_UNIT);
  models.push({
    model: 'CONSERVATIVE_SLIPPAGE',
    entryPrice: slippagePrice,
    available: true,
    slippageBps: slippageBufferBps,
  });

  return Object.freeze(models.map((model) => Object.freeze(model))) as EntryPriceAssumption[];
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
  const horizonTrades = orderedTrades(priceHistory, t0)
    .reverse()
    .filter((t) => t.eventTime <= horizonEnd);

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
    result[h] = Object.freeze(computeHorizonOutcome(signal, entryPrice, priceHistory, h));
  }
  return Object.freeze(result);
}

/** Computes isolated prospective results for every entry assumption. */
export function computeEntryModelOutcomes(
  signal: ShadowSignalSnapshot,
  priceHistory: Array<{ eventTime: number; price: number }>,
  scenarios: CostScenario[] = DEFAULT_COST_SCENARIOS,
  config: MicroBurstConfig = defaultMicroBurstConfig(),
): Readonly<Record<EntryPriceModel, EntryModelOutcome>> {
  const models = computeEntryModels(signal, priceHistory);
  const outcomes = {} as Record<EntryPriceModel, EntryModelOutcome>;
  for (const assumption of models) {
    if (!assumption.available || assumption.entryPrice === null) {
      outcomes[assumption.model] = Object.freeze({
        assumption,
        horizons: null,
        barrierOutcome: null,
        dynamicExitOutcome: null,
        grossBps: null,
        costScenarios: null,
        costComponents: null,
      });
      continue;
    }
    const horizons = computeAllHorizons(signal, assumption.entryPrice, priceHistory);
    const lastTrade = orderedTrades(priceHistory, signal.signalAtMs)[0];
    const grossBps = lastTrade
      ? sideAwareReturnBps(assumption.entryPrice, lastTrade.price, signal.side)
      : 0;
    const costComponents = computeCostComponents(grossBps, scenarios, assumption.slippageBps ?? 0);
    outcomes[assumption.model] = Object.freeze({
      assumption,
      horizons,
      barrierOutcome: aggregateBarrierOutcome(horizons),
      dynamicExitOutcome: simulateDynamicExit(signal, assumption.entryPrice, priceHistory, config),
      grossBps,
      // Conservative entry already includes its adverse entry adjustment. Do not charge
      // that same adjustment again as scenario slippage.
      costScenarios: Object.freeze(
        Object.fromEntries(
          Object.entries(costComponents).map(([label, components]) => [
            label,
            grossBps - components.totalBps,
          ]),
        ),
      ),
      costComponents: Object.freeze(costComponents),
    });
  }
  return Object.freeze(outcomes);
}

// ── Aggregate Barrier Outcome ──────────────────────────────

export function aggregateBarrierOutcome(horizons: Record<number, HorizonOutcome>): BarrierOutcome {
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

export function computeCostComponents(
  grossBps: number,
  scenarios: CostScenario[],
  entrySlippageBps = 0,
): Record<string, CostComponents> {
  const result: Record<string, CostComponents> = {};
  for (const scenario of scenarios) {
    const entry = Math.max(0, entrySlippageBps);
    const additional = Math.max(0, scenario.slippageBps - entry);
    result[scenario.label] = {
      feeBps: scenario.feeBps,
      entrySlippageBps: entry,
      additionalSlippageBps: additional,
      // Entry slippage is already present in grossBps for the conservative model.
      totalBps: scenario.feeBps + additional,
    };
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

  const trajectory = orderedTrades(priceHistory, t0).reverse();

  if (trajectory.length === 0) return null;

  let peakPrice = entryPrice;
  let troughPrice = entryPrice;
  let currentStopPrice = signal.structuralStopPrice;

  for (const trade of trajectory) {
    const currentPrice = trade.price;
    const timeInTradeMs = trade.eventTime - t0;

    const stopTouched =
      side === 'LONG' ? currentPrice <= currentStopPrice : currentPrice >= currentStopPrice;
    if (stopTouched)
      return priceExit(
        currentPrice,
        trade.eventTime,
        entryPrice,
        side,
        currentStopPrice === entryPrice ? 'BREAK_EVEN' : 'HARD_INVALIDATION',
      );
    if (
      side === 'LONG'
        ? currentPrice >= signal.destinationPrice
        : currentPrice <= signal.destinationPrice
    )
      return priceExit(currentPrice, trade.eventTime, entryPrice, side, 'TARGET');
    if (currentPrice > peakPrice) peakPrice = currentPrice;
    if (currentPrice < troughPrice) troughPrice = currentPrice;
    const favorableBps = sideAwareReturnBps(
      entryPrice,
      side === 'LONG' ? peakPrice : troughPrice,
      side,
    );
    const adverseBps = -sideAwareReturnBps(
      entryPrice,
      side === 'LONG' ? troughPrice : peakPrice,
      side,
    );
    if (timeInTradeMs < config.exitProofWindowMs && adverseBps >= config.exitImmediateAdverseBps)
      return priceExit(currentPrice, trade.eventTime, entryPrice, side, 'EARLY_FAILURE');
    const callbackBps =
      side === 'LONG'
        ? ((peakPrice - currentPrice) / peakPrice) * BPS_PER_UNIT
        : ((currentPrice - troughPrice) / troughPrice) * BPS_PER_UNIT;
    if (
      favorableBps >= config.exitTrailingActivationBps &&
      callbackBps >= config.exitTrailingCallbackBps
    )
      return priceExit(currentPrice, trade.eventTime, entryPrice, side, 'TRAILING');
    if (favorableBps >= config.exitBreakEvenActivationBps) currentStopPrice = entryPrice;
    if (timeInTradeMs >= config.exitProofWindowMs && favorableBps < config.exitMinProofExcursionBps)
      return priceExit(currentPrice, trade.eventTime, entryPrice, side, 'EARLY_FAILURE');
    if (timeInTradeMs >= config.exitMaxHoldMs)
      return priceExit(currentPrice, trade.eventTime, entryPrice, side, 'MAX_HOLD');
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

function orderedTrades<T extends { eventTime: number; price: number }>(
  priceHistory: T[],
  t0: number,
): T[] {
  return priceHistory
    .filter((trade) => trade.eventTime > t0 && Number.isFinite(trade.price) && trade.price > 0)
    .map((trade, index) => ({ trade, index }))
    .sort((a, b) => b.trade.eventTime - a.trade.eventTime || b.index - a.index)
    .map(({ trade }) => trade);
}

function priceExit(
  price: number,
  eventTime: number,
  entryPrice: number,
  side: Side,
  reason: CounterfactualExitReason,
): DynamicExitOutcome {
  const grossBps = sideAwareReturnBps(entryPrice, price, side);
  return Object.freeze({
    counterfactualExitReason: reason,
    counterfactualExitAtMs: eventTime,
    counterfactualExitPrice: price,
    counterfactualGrossBps: grossBps,
    counterfactualNetBps: grossBps,
  });
}

// ── Snapshot from Evaluation Result ────────────────────────

export function freezeSignalSnapshot(params: {
  schemaVersion?: 1;
  shadowSignalId: string;
  cohortId?: string;
  episodeId?: string;
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
  return Object.freeze({
    ...params,
    momentum: Object.freeze({ ...params.momentum }),
    book: Object.freeze({ ...params.book }),
    tradeFlow: Object.freeze({ ...params.tradeFlow }),
    btc: Object.freeze({ ...params.btc }),
  });
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
