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
