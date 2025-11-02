export type Side = 'LONG' | 'SHORT';

export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

export type BotMode = 'IDLE' | 'LONG_RIDE' | 'SHORT_RIDE';

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
  lastEntryUsedBalance?: number;
  lastEntryFilters?: Record<string, unknown>;
  lastCommissionEstimate?: number;
  lastOrderId?: string;
  postExitSide?: Side;
  postExitPrice?: number;
  postExitAt?: number;
  postExitMin?: number;
  postExitMax?: number;
  postExitReady?: boolean;
  postExitCondition?: 'pullback' | 'breakout' | 'timeout';
};

type SignalCommon = {
  reason?: string;
  diagnostics?: Record<string, unknown>;
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
