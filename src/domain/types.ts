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
  lastSide?: Side;
  lastEntryPrice?: number;
  lastLeverage?: number;
  lastEntryAt?: number;
  peakRoe?: number;
  lastTPAt?: number;
  lastExitReason?: string;
  lastExitAt?: number; // ← NUEVO
  lowestRoe?: number; // MAE (Maximum Adverse Excursion)
  lastCheckAt?: number; // Heartbeat for Smart Exit
  lastAtrFetchedAt?: number; // Throttle for ATR fetch
  lastAtrValue?: number;     // Cached ATR Value

  // NUEVO: recordatorio de que ya armamos los brackets para esta posición
  bracketsArmedAt?: number;
  // (opcional) recordar el modo real leído de la posición
  posSideMode?: 'BOTH' | 'LONG' | 'SHORT';

  lastEntryQty?: number; // qty de la ENTRADA inicial (base para piramidación)
  pyramidUnits?: number; // nº de adds realizados en este “ride”
  lastPyramidPrice?: number; // precio de referencia del último add
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
  positionOwner?: 'AEGIS' | 'EXTERNAL' | 'UNKNOWN';
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
  lastMlProb?: number; // Probabilidad del modelo ML al entrar
  lastMlThreshold?: number; // Threshold usado al entrar

  // Ninja Protocol v2.0
  panicCounter?: number; // Contador de ticks consecutivos con señal de pánico
  lastEntryTime?: number; // Timestamp de entrada para Time Decay
  highestRatchetStop?: number; // High Water Mark para el Stop Loss (Monotonicity Enforcement)

  // Native Brackets v8.0: Regime persistence for ensure-brackets.ts
  currentRegime?: 'AEGIS_TURBO' | 'BLOODBATH' | 'WHALE' | 'MONK' | 'BUNKER' | 'BERZERKER';
  lastPeakPrice?: number; // Highest/Lowest price reached during trade (for trailing stop)

  // Aegis Turbo position metadata
  lastStrategy?: 'AEGIS_TURBO' | 'MOMENTUM_RIDE';
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

  shadowPos?: ShadowPosition | null; // <-- For shadow trading
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
  peakRoe: number;        // Track max ROE for trailing stop
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

// src/core/types.ts
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
