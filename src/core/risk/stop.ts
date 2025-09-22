export function roundToTick(p: number, tick: number, prec: number) {
  const r = Math.round(p / tick) * tick;
  return Number(r.toFixed(prec));
}

export function computeStopFromLiqTicks(params: {
  side: 'LONG' | 'SHORT';
  liqPrice: number;
  currentPrice: number;
  entryPrice: number;
  tickSize: number;
  pricePrecision: number;
  ticksAboveLiq: number;
}) {
  const { side, liqPrice, currentPrice, entryPrice, tickSize, pricePrecision, ticksAboveLiq } =
    params;
  let raw =
    side === 'LONG' ? liqPrice + ticksAboveLiq * tickSize : liqPrice - ticksAboveLiq * tickSize;
  if (side === 'LONG') {
    raw = Math.min(raw, currentPrice - tickSize);
    raw = Math.max(raw, liqPrice + tickSize * 0.5);
    raw = Math.min(raw, entryPrice - tickSize);
  } else {
    raw = Math.max(raw, currentPrice + tickSize);
    raw = Math.min(raw, liqPrice - tickSize * 0.5);
    raw = Math.max(raw, entryPrice + tickSize);
  }
  return roundToTick(raw, tickSize, pricePrecision);
}

// src/core/risk/stop.ts - Agregar esta nueva función
export function computeStopFromMaxLoss(params: {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  tickSize: number;
  pricePrecision: number;
  ticksFromEntry: number; // Los 69 ticks de tu config
}) {
  const { side, entryPrice, tickSize, pricePrecision, ticksFromEntry } = params;

  // Calcular stop directamente desde el precio de entrada
  let stopPrice: number;
  if (side === 'LONG') {
    stopPrice = entryPrice - ticksFromEntry * tickSize;
  } else {
    stopPrice = entryPrice + ticksFromEntry * tickSize;
  }

  return roundToTick(stopPrice, tickSize, pricePrecision);
}
