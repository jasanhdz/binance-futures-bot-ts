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
