import { Candle } from '../core/types';

const toNumber = (value: unknown, fallback: number): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

function emaLast(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const alpha = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return ema;
}

function atrWilder(candles: Candle[], period: number): number | undefined {
  if (candles.length < period + 1) return undefined;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const hl = curr.high - curr.low;
    const hc = Math.abs(curr.high - prev.close);
    const lc = Math.abs(curr.low - prev.close);
    trs.push(Math.max(hl, hc, lc));
  }

  let atr = trs.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = ((atr * (period - 1)) + trs[i]) / period;
  }
  return atr;
}

function rsiWilder(closes: number[], period: number): number | undefined {
  if (closes.length < period + 1) return undefined;
  const deltas = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 0; i < period; i++) {
    const delta = deltas[i];
    if (delta >= 0) gainSum += delta;
    else lossSum -= delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period; i < deltas.length; i++) {
    const delta = deltas[i];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) {
    return avgGain > 0 ? 100 : 50;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export type MlFilterResult = {
  longReason?: string;
  shortReason?: string;
  emaBase: number;
  atrValue: number;
  rsiValue: number;
  bodyRatio: number;
  extLong: number;
  extShort: number;
};

export function evaluateMlFilters(candles: Candle[], config: Record<string, unknown>): MlFilterResult {
  const last = candles[candles.length - 1];
  const closes = candles.map((c) => c.close);

  const emaCandidate = emaLast(closes, 21);
  const atrCandidate = atrWilder(candles, 14);
  const rsiCandidate = rsiWilder(closes, 14);

  const closePrice = last.close;
  const emaBase = Number.isFinite(emaCandidate) ? (emaCandidate as number) : closePrice;
  const atrValue = Number.isFinite(atrCandidate) ? (atrCandidate as number) : 0;
  const rsiValue = Number.isFinite(rsiCandidate) ? (rsiCandidate as number) : 50;

  const maxExtPct = toNumber((config as any).ML_MAX_EXT_PCT, 0.015);
  const maxRsi = toNumber((config as any).ML_MAX_RSI, 68);
  const minRsi = toNumber((config as any).ML_MIN_RSI, 32);
  const maxBodyAtr = toNumber((config as any).ML_MAX_BODY_ATR, 2.5);

  const body = Math.abs(last.close - last.open);

  let longReason: string | undefined;
  let shortReason: string | undefined;

  let extLong = 0;
  let extShort = 0;

  if (emaBase > 0 && Number.isFinite(emaBase) && Number.isFinite(closePrice)) {
    extLong = (closePrice - emaBase) / emaBase;
    extShort = (emaBase - closePrice) / emaBase;
    if (extLong > maxExtPct) {
      longReason = `ml_filter_ext_long=${extLong.toFixed(3)}`;
    }
    if (extShort > maxExtPct) {
      shortReason = `ml_filter_ext_short=${extShort.toFixed(3)}`;
    }
  }

  if (Number.isFinite(rsiValue)) {
    if (rsiValue > maxRsi) {
      longReason = longReason ?? `ml_filter_rsi_high=${rsiValue.toFixed(1)}`;
    }
    if (rsiValue < minRsi) {
      shortReason = shortReason ?? `ml_filter_rsi_low=${rsiValue.toFixed(1)}`;
    }
  }

  let bodyRatio = 0;
  if (atrValue > 0 && Number.isFinite(atrValue)) {
    bodyRatio = body / atrValue;
    if (bodyRatio > maxBodyAtr) {
      if (last.close >= last.open) {
        longReason = longReason ?? `ml_filter_body_ratio=${bodyRatio.toFixed(2)}`;
      }
      if (last.close <= last.open) {
        shortReason = shortReason ?? `ml_filter_body_ratio=${bodyRatio.toFixed(2)}`;
      }
    }
  }

  return {
    longReason,
    shortReason,
    emaBase,
    atrValue,
    rsiValue,
    bodyRatio,
    extLong,
    extShort,
  };
}
