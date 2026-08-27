// ── M3 Prospective Shadow Outcome Types ─────────────────────
// Unit convention preserved:
//   price returns: decimal  (0.001 = 0.1% = 10 bps)
//   bps:           10 = 0.1%
// ───────────────────────────────────────────────────────────

import { Side } from '../../types';

// ── Shadow Signal Snapshot ─────────────────────────────────

export interface ShadowSignalSnapshot {
  schemaVersion?: 1;
  shadowSignalId: string;
  cohortId?: string;
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
  momentum: {
    direction: Side | 'NEUTRAL';
    strength: number;
    continuationScore: number;
    slope1m?: number;
    slope3m?: number;
    slope5m?: number;
  };
  book: {
    status: string;
    ageMs: number | null;
    imbalance: number;
    imbalanceSlope: number | null;
    temporalAbsorption: boolean;
    temporalSweep: boolean;
  };
  tradeFlow: {
    buyTakerVolume: number;
    sellTakerVolume: number;
    netTakerFlow: number;
    sampleCount: number;
  };
  btc: {
    status: string;
    ageMs: number | null;
    ret1m: number | null;
    ret3m: number | null;
    ret5m: number | null;
    acceleration: number | null;
    direction: Side | 'NEUTRAL' | null;
    conflict: boolean;
  };
  confidence: number;
  leverageTier: string;
  leverage: number;
  positionFraction: number;
  microRegime: string;
}

// ── Entry Price Models ─────────────────────────────────────

export type EntryPriceModel = 'SIGNAL_PRICE' | 'NEXT_TRADE' | 'CONSERVATIVE_SLIPPAGE';

export interface EntryPriceAssumption {
  model: EntryPriceModel;
  entryPrice: number | null;
  available?: boolean;
  /** Fixed adverse entry adjustment. Always expressed in bps. */
  slippageBps?: number;
}

/** Exchange trade data retained for prospective outcome evaluation. */
export interface MicroBurstTradeRecord {
  eventTime: number;
  receivedAtMs: number;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
  tradeTime?: number;
  aggregateTradeId?: number;
  firstTradeId?: number;
  lastTradeId?: number;
}

// ── Cost Scenarios ─────────────────────────────────────────

export interface CostScenario {
  label: string;
  feeBps: number;
  slippageBps: number;
}

export const DEFAULT_COST_SCENARIOS: CostScenario[] = [
  { label: 'cost_0', feeBps: 0, slippageBps: 0 },
  { label: 'cost_10', feeBps: 7, slippageBps: 3 },
  { label: 'cost_14', feeBps: 10, slippageBps: 4 },
  { label: 'cost_20', feeBps: 14, slippageBps: 6 },
  { label: 'cost_30', feeBps: 20, slippageBps: 10 },
];

// ── Horizon Outcome ────────────────────────────────────────

export type BarrierOutcome = 'TARGET_FIRST' | 'STOP_FIRST' | 'NEITHER' | 'AMBIGUOUS_SAME_INTERVAL';

export interface HorizonOutcome {
  horizonMs: number;
  mfeBps: number;
  maeBps: number;
  finalReturnBps: number;
  timeToMfeMs: number;
  timeToMaeMs: number;
  stopTouched: boolean;
  targetTouched: boolean;
  barrierOutcome: BarrierOutcome;
  firstTouchAtMs: number | null;
  priceAtHorizon: number | null;
  tradeCount: number;
}

// ── Dynamic Exit Counterfactual ────────────────────────────

export type CounterfactualExitReason =
  | 'HARD_INVALIDATION'
  | 'TARGET'
  | 'BREAK_EVEN'
  | 'TRAILING'
  | 'EARLY_FAILURE'
  | 'MAX_HOLD'
  | 'HOLD_AT_HORIZON';

export interface DynamicExitOutcome {
  counterfactualExitReason: CounterfactualExitReason;
  counterfactualExitAtMs: number;
  counterfactualExitPrice: number;
  counterfactualGrossBps: number;
  counterfactualNetBps: number;
}

export interface EntryModelOutcome {
  assumption: Readonly<EntryPriceAssumption>;
  horizons: Readonly<Record<number, Readonly<HorizonOutcome>>> | null;
  barrierOutcome: BarrierOutcome | null;
  dynamicExitOutcome: Readonly<DynamicExitOutcome> | null;
  grossBps: number | null;
  costScenarios: Readonly<Record<string, number>> | null;
}

// ── Complete Outcome Record ────────────────────────────────

export interface ProspectiveOutcomeRecord {
  schemaVersion?: 1;
  shadowSignalId: string;
  cohortId?: string;
  episodeId: string;
  symbol: string;
  side: Side;
  signalAtMs: number;
  entryPriceModels: EntryPriceAssumption[];
  /** Independent outcomes; unavailable NEXT_TRADE has null outcome values, never zero-filled. */
  entryOutcomes?: Readonly<Record<EntryPriceModel, EntryModelOutcome>>;
  structuralStopPrice: number;
  destinationPrice: number;
  support: number | null;
  resistance: number | null;
  roomToTargetBps: number;
  riskToInvalidationBps: number;
  rewardRisk: number;
  confidence: number;
  leverageTier: string;
  leverage: number;
  microRegime: string;
  momentum: ShadowSignalSnapshot['momentum'];
  book: ShadowSignalSnapshot['book'];
  tradeFlow: ShadowSignalSnapshot['tradeFlow'];
  btc: ShadowSignalSnapshot['btc'];
  horizons: Record<number, HorizonOutcome>;
  barrierOutcome: BarrierOutcome;
  dynamicExitOutcome: DynamicExitOutcome | null;
  grossBps: number;
  costScenarios: Record<string, number>;
  completedAtMs: number;
  strategyVersion: string;
  codeCommitSha: string;
  configHash: string;
}

// ── Pending Signal (in-memory) ─────────────────────────────

export interface PendingOutcome {
  signal: ShadowSignalSnapshot;
  episodeId: string;
  entryModels: EntryPriceAssumption[];
  /** Trade events after T0, sorted by eventTime ascending. */
  priceHistory: Array<{ eventTime: number; price: number }>;
  /** Whether NEXT_TRADE entry has been resolved. */
  nextTradeResolved: boolean;
  /** Pending horizon completions. */
  pendingHorizons: Set<number>;
  /** Completed horizons. */
  completedHorizons: Map<number, HorizonOutcome>;
  /** Peak/trough tracking across all horizons. */
  peakPrice: number;
  troughPrice: number;
  createdAtMs: number;
}

// ── Episode Definition ─────────────────────────────────────

export interface EpisodeDefinition {
  episodeId: string;
  primarySignalId: string;
  symbol: string;
  side: Side;
  structuralLevel: number;
  startedAtMs: number;
  signalIds: string[];
}

// ── Health Metrics ─────────────────────────────────────────

export interface OutcomeTrackerHealth {
  signalsObserved: number;
  pendingOutcomes: number;
  completedOutcomes: number;
  outcomeErrors: number;
  targetFirst: number;
  stopFirst: number;
  neither: number;
  ambiguous: number;
  meanMfeBps: number;
  meanMaeBps: number;
}
