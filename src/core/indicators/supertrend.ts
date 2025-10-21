type CandleLike = { high: number; low: number; close: number };

function trueRange(curr: CandleLike, prev: CandleLike) {
  const highLow = curr.high - curr.low;
  const highClose = Math.abs(curr.high - prev.close);
  const lowClose = Math.abs(curr.low - prev.close);
  return Math.max(highLow, highClose, lowClose);
}

function atrSeries(candles: CandleLike[], period: number): number[] {
  const len = candles.length;
  if (len === 0) return [];
  const trs: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < len; i++) {
    trs.push(trueRange(candles[i], candles[i - 1]));
  }
  const atr: number[] = [];
  let prev = trs.slice(0, period).reduce((acc, v) => acc + v, 0) / Math.max(1, Math.min(period, trs.length));
  atr.push(prev);
  const alpha = 1 / Math.max(1, period);
  for (let i = 1; i < trs.length; i++) {
    prev = prev + alpha * (trs[i] - prev);
    atr.push(prev);
  }
  return atr;
}

export type SupertrendResult = {
  trend: 'UP' | 'DOWN';
  line: number;
  upper: number;
  lower: number;
};

export function supertrend(candles: CandleLike[], period = 10, multiplier = 3): SupertrendResult {
  if (candles.length === 0) {
    return { trend: 'UP', line: NaN, upper: NaN, lower: NaN };
  }
  const atr = atrSeries(candles, period);
  const hl2 = candles.map((c) => (c.high + c.low) / 2);

  const upperBand: number[] = [];
  const lowerBand: number[] = [];
  const trendLine: number[] = [];
  let trendDir: 'UP' | 'DOWN' = 'UP';

  for (let i = 0; i < candles.length; i++) {
    const basicUpper = hl2[i] + multiplier * (atr[i] ?? atr[atr.length - 1] ?? 0);
    const basicLower = hl2[i] - multiplier * (atr[i] ?? atr[atr.length - 1] ?? 0);

    if (i === 0) {
      upperBand.push(basicUpper);
      lowerBand.push(basicLower);
      trendLine.push(basicLower);
      trendDir = 'UP';
      continue;
    }

    const prevUpper = upperBand[i - 1];
    const prevLower = lowerBand[i - 1];
    const prevTrendLine = trendLine[i - 1];
    const prevClose = candles[i - 1].close;

    const finalUpper = basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper;
    const finalLower = basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower;
    upperBand.push(finalUpper);
    lowerBand.push(finalLower);

    if (prevTrendLine === prevUpper) {
      if (candles[i].close <= finalUpper) {
        trendLine.push(finalUpper);
        trendDir = 'DOWN';
      } else {
        trendLine.push(finalLower);
        trendDir = 'UP';
      }
    } else {
      if (candles[i].close >= finalLower) {
        trendLine.push(finalLower);
        trendDir = 'UP';
      } else {
        trendLine.push(finalUpper);
        trendDir = 'DOWN';
      }
    }
  }

  const lastIdx = trendLine.length - 1;
  return {
    trend: trendDir,
    line: trendLine[lastIdx],
    upper: upperBand[lastIdx],
    lower: lowerBand[lastIdx],
  };
}
