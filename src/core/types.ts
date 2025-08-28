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

  // NUEVO: recordatorio de que ya armamos los brackets para esta posición
  bracketsArmedAt?: number;
  // (opcional) recordar el modo real leído de la posición
  posSideMode?: 'BOTH' | 'LONG' | 'SHORT';

  lastEntryQty?: number; // qty de la ENTRADA inicial (base para piramidación)
  pyramidUnits?: number; // nº de adds realizados en este “ride”
  lastPyramidPrice?: number; // precio de referencia del último add
  lastTrailStop?: number;
};

export type Signal =
  | { action: 'ENTER_LONG'; reason?: string }
  | { action: 'ENTER_SHORT'; reason?: string }
  | { action: 'EXIT'; reason?: string }
  | { action: 'IDLE'; reason?: string };
