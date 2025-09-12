import { Candle } from '../core/types';
import { ema } from '../core/indicators/ema';

function rsiSMA(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50; // misma convención de Py cuando faltan datos
  let gain = 0,
    loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss += -d;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss <= 1e-12) return 50; // ← MATCH con Python: fillna(50) cuando no hay pérdidas
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atrSMA_pct(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let sumTR = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i],
      p = candles[i - 1];
    const a = c.high - c.low;
    const b = Math.abs(c.high - p.close);
    const cTR = Math.abs(c.low - p.close);
    const tr = Math.max(a, b, cTR); // ← MATCH con Python
    sumTR += tr;
  }
  const atr = sumTR / period; // rolling mean simple (no RMA)
  const lastClose = candles[candles.length - 1].close;
  return atr / Math.max(1e-9, lastClose);
}

export function computeFeatures(cs: Candle[]) {
  const last = cs[cs.length - 1];
  const prev = cs[cs.length - 2];

  const closes = cs.map((c) => c.close);
  const vols = cs.map((c) => c.volume);

  const r = Math.max(1e-9, last.high - last.low);
  const body_pct = Math.abs(last.close - last.open) / r;
  const wickiness =
    (last.high - Math.max(last.open, last.close) + (Math.min(last.open, last.close) - last.low)) /
    r;

  const rsi = rsiSMA(closes, 14);

  const ema25 = ema(closes, 25);
  const emaSlope =
    (ema25[ema25.length - 1] - ema25[ema25.length - 9]) / Math.max(1e-9, ema25[ema25.length - 9]); // ← MATCH con Python shift(8)

  const atr_pct = atrSMA_pct(cs, 14);

  const vol20 = vols.slice(-20); // incluye la actual
  const volAvg20 = vol20.length ? vol20.reduce((s, v) => s + v, 0) / vol20.length : 0;
  const vol_ratio = volAvg20 > 0 ? last.volume / volAvg20 : 1.0;

  const mom3 = closes.length >= 4 ? closes[closes.length - 1] / closes[closes.length - 4] - 1 : 0;
  const mom12 =
    closes.length >= 13 ? closes[closes.length - 1] / closes[closes.length - 13] - 1 : 0;

  return { rsi, ema_slope: emaSlope, atr_pct, vol_ratio, body_pct, wickiness, mom3, mom12 };
}
