type Candle = { high: number; low: number; close: number };

/** Wilder ADX: period TR/DM seed, Wilder DI smoothing, then period DX seed. */
export function wilderAdxSeries(candles: Candle[], period = 14): number[] {
  if (!Number.isInteger(period) || period < 1 || candles.length < 2 * period) return [];
  if (
    candles.some(
      (c) =>
        !c ||
        ![c.high, c.low, c.close].every(Number.isFinite) ||
        c.low <= 0 ||
        c.low > c.close ||
        c.close > c.high,
    )
  )
    return [];
  let tr = 0,
    plus = 0,
    minus = 0,
    dxSum = 0,
    dxCount = 0,
    adx = 0;
  const result: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i],
      p = candles[i - 1];
    const up = c.high - p.high,
      down = p.low - c.low;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    const range = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= period) {
      tr += range;
      plus += pdm;
      minus += mdm;
    } else {
      tr = tr - tr / period + range;
      plus = plus - plus / period + pdm;
      minus = minus - minus / period + mdm;
    }
    if (i < period) continue;
    const pdi = tr > 0 ? (100 * plus) / tr : 0;
    const mdi = tr > 0 ? (100 * minus) / tr : 0;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    dxCount++;
    if (dxCount <= period) {
      dxSum += dx;
      if (dxCount === period) {
        adx = dxSum / period;
        result.push(adx);
      }
    } else {
      adx = (adx * (period - 1) + dx) / period;
      result.push(adx);
    }
  }
  return result;
}
