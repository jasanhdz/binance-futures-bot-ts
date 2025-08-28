export function atr(candles: { high: number; low: number; close: number }[], len: number) {
  if (candles.length < len + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i],
      p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trs.push(tr);
  }
  // EMA del TR (versión clásica de Wilder es RMA; servirá EMA simple)
  const k = 2 / (len + 1);
  let prev = trs[0];
  for (let i = 1; i < trs.length; i++) prev = trs[i] * k + prev * (1 - k);
  return prev;
}
