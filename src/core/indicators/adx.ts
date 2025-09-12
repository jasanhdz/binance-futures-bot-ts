export function adx(high: number[], low: number[], close: number[], len = 14) {
  if (high.length < len + 2) return { adx: NaN, plusDI: NaN, minusDI: NaN };
  const tr: number[] = [],
    plusDM: number[] = [],
    minusDM: number[] = [];
  for (let i = 1; i < high.length; i++) {
    const up = high[i] - high[i - 1],
      dn = low[i - 1] - low[i];
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    const a = high[i] - low[i];
    const b = Math.abs(high[i] - close[i - 1]);
    const c = Math.abs(low[i] - close[i - 1]);
    tr.push(Math.max(a, b, c));
  }
  const rma = (arr: number[], n: number) => {
    let v = arr[0],
      k = 1 / n;
    for (let i = 1; i < arr.length; i++) v = v * (1 - k) + arr[i] * k;
    return v;
  };
  const tr14 = rma(tr.slice(-len), len);
  const p14 = rma(plusDM.slice(-len), len);
  const m14 = rma(minusDM.slice(-len), len);
  const plusDI = tr14 > 0 ? 100 * (p14 / tr14) : NaN;
  const minusDI = tr14 > 0 ? 100 * (m14 / tr14) : NaN;
  const dx = plusDI + minusDI > 0 ? (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI) : NaN;
  // ADX como RMA de DX; para gateo basta este valor instantáneo
  const adx = dx;
  return { adx, plusDI, minusDI };
}

export function sma(arr: number[], n: number) {
  const k = Math.min(arr.length, n);
  if (k <= 0) return NaN;
  let s = 0;
  for (let i = arr.length - k; i < arr.length; i++) s += arr[i];
  return s / k;
}
