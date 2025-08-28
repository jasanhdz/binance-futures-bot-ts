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
};

export type Signal =
  | { action: 'ENTER_LONG'; reason?: string }
  | { action: 'ENTER_SHORT'; reason?: string }
  | { action: 'EXIT'; reason?: string }
  | { action: 'IDLE'; reason?: string };
