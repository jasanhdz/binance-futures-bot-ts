export type OrderResponse = {
  orderId: number;
  avgFillPrice?: number;
  executedQty?: number;
  stopPrice?: number;
};

export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

export type BotState = {
  mode: 'IDLE' | 'LONG_RIDE' | 'SHORT_RIDE';
  lastSide?: 'LONG' | 'SHORT';
  lastEntryPrice?: number;
  lastTPAt?: number;
  lastExitReason?: string;
  peakRoe?: number; // ← nuevo
  lastLeverage?: number; // ← nuevo
  tpTrigger?: number; // opcional, si quieres la inferencia de TP
};
