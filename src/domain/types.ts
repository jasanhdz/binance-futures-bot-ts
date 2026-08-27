import type { StrategyFreezeState, StrategyId } from './strategy/StrategyIdentity';

export type Side = 'LONG' | 'SHORT';

export type Candle = {
  openTime: number;
  timestamp: number; // Alias for openTime
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  closeTime: number;
};

export type BotMode = 'IDLE' | 'LONG_RIDE' | 'SHORT_RIDE';
export type TradeOwnershipStatus = 'VERIFIED' | 'TAINTED' | 'UNKNOWN';

export type BotState = {
  mode: BotMode;
  dailyRisk?: {
    dayKey: number;
    tradesToday: number;
    strategyTradesToday: Partial<Record<StrategyId, number>>;
    dailyStartBalance?: number | null;
  };
  lastSide?: Side;
  lastEntryPrice?: number;
  lastLeverage?: number;
  lastEntryAt?: number;
  peakRoe?: number;
  lastTPAt?: number;
  lastExitReason?: string;
  lastExitAt?: number;
  lowestRoe?: number;
  lastCheckAt?: number;
  lastAtrFetchedAt?: number;
  lastAtrValue?: number;

  bracketsArmedAt?: number;
  posSideMode?: 'BOTH' | 'LONG' | 'SHORT';

  lastEntryQty?: number;
  pyramidUnits?: number;
  lastPyramidPrice?: number;
  lastTrailStop?: number;
  bracketsAttached?: boolean;
  lastIntelliTpAt?: number;
  intelliTpState?: 'ride' | 'exit';

  lastTradeId?: string;
  lastStrategyName?: string;
  lastEntryWallet?: number;
  lastEntryMargin?: number;
  lastEntryUsedBalance?: number;
  lastEntryFilters?: Record<string, unknown>;
  lastCommissionEstimate?: number;
  lastOrderId?: string;
  /** BOT is canonical. AEGIS remains readable only for persisted legacy state migration. */
  positionOwner?: 'BOT' | 'AEGIS' | 'EXTERNAL' | 'UNKNOWN';
  tradeOrigin?: 'BOT' | 'MANUAL_EXTERNAL' | 'UNKNOWN';
  ownershipStatus?: TradeOwnershipStatus;
  eligibleForBotMetrics?: boolean;
  metricsExclusionReason?: string | null;
  postExitSide?: Side;
  postExitPrice?: number;
  postExitAt?: number;
  postExitMin?: number;
  postExitMax?: number;
  postExitReady?: boolean;
  postExitCondition?: 'pullback' | 'breakout' | 'timeout';
  lowFundsActive?: boolean;
  lastMlProb?: number;
  lastMlThreshold?: number;

  // Ninja Protocol v2.0
  panicCounter?: number;
  lastEntryTime?: number;
  highestRatchetStop?: number;

  // Native Brackets v8.0: Regime persistence for ensure-brackets.ts
  currentRegime?: 'AEGIS_TURBO' | 'BLOODBATH' | 'WHALE' | 'MONK' | 'BUNKER' | 'BERZERKER';
  lastPeakPrice?: number;

  // Canonical strategy ownership. These fields are additive during migration.
  lastStrategy?: StrategyId;
  lastStrategyVersion?: string;
  lastStrategyHash?: string;
  lastConfigHash?: string;
  lastCodeCommitSha?: string;
  lastStrategyFreezeState?: StrategyFreezeState;

  // Aegis Turbo / legacy lifecycle metadata
  lastStopRoe?: number;
  lastBreakEvenRoe?: number;
  breakEvenArmed?: boolean;
  breakEvenExecuted?: boolean;
  lastBreakEvenStop?: number;
  lastBreakEvenAt?: number;
  lastStopPrice?: number;
  lastTakeProfitRoe?: number;
  lastTrailingActivationRoe?: number;
  lastTrailingCallbackRoe?: number;
  /** Frozen at entry; an open trade keeps its entry-time max-hold policy. */
  lastMaxHoldMs?: number;
  lastAegisTurboScore?: number;
  lastAegisRawReason?: string;
  lastAegisGatedReason?: string;
  lastAegisGatedBlockedBy?: string | null;
  lastPositionFraction?: number;
  lastRequestedLeverage?: number;
  lastActualLeverage?: number;
  lastBracketStatus?: 'PENDING' | 'OK' | 'FAILED_CLOSED';
  lastManualSizeIncreaseAt?: number;
  lastManualSizeIncreaseQty?: number;
  lastManualSizeIncreasePreviousQty?: number;
  lastManualSizeIncreaseBracketMode?: 'CLOSE_POSITION' | 'REDUCE_ONLY_QTY';

  // Aegis Probe Mode v1 runtime metadata
  probeModeActive?: boolean;
  lastProbeAt?: number;
  lastProbeTradeId?: string;
  probeEntryTimestamps?: number[];
  lastStopLossAt?: number;

  // Aegis Exit Eye v0.1 runtime counters
  exitEyeNeutralCount?: number;
  exitEyeNeutralCloseCount?: number;
  exitEyeOppositeCount?: number;
  lastExitEyeAction?: string;
  lastExitEyeReason?: string;
  lastExitEyeAt?: number;
  lastExitEyeTelegramAt?: number;

  shadowPos?: ShadowPosition | null;
};

export interface ShadowPosition {
  active: boolean;
  symbol: string;
  side: Side;
  entryPrice: number;
  initialBalance: number;
  confidence: number;
  quantity: number;
  leverage: number;
  hardStopPrice: number;
  tpPrice: number;
  entryAt: number;
  peakPrice: number;
  lowestPrice: number;
  peakRoe: number;
}

type SignalCommon = {
  reason?: string;
  diagnostics?: Record<string, unknown>;
  confidence?: number;
  stopLoss?: number;
  takeProfit?: number;
  metadata?: Record<string, unknown>;
};

export type Signal =
  | ({ action: 'ENTER_LONG' } & SignalCommon)
  | ({ action: 'ENTER_SHORT' } & SignalCommon)
  | ({ action: 'EXIT' } & SignalCommon)
  | ({ action: 'IDLE' } & SignalCommon);

export type Trade = {
  side: 'LONG' | 'SHORT';
  entryIdx: number;
  entryTs: number;
  entryPx: number;
  exitIdx: number;
  exitTs: number;
  exitPx: number;
  exit: 'TP' | 'SL' | 'Timeout' | 'StrategyExit';
  barsHeld: number;
  pnlPct: number;
  mfePct: number;
  maePct: number;
  reason?: string;
  adx: number;
  longP: number;
  shortP: number;
  mlMargin: number;
  vRatio: number;
  bbUpper?: number;
  bbLower?: number;
  distTopPct?: number;
};
