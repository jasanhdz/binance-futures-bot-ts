import { Candle } from '../core/types';
import { ema } from '../core/indicators/ema';

export function computeFeatures(cs: Candle[]) {
  const last = cs[cs.length - 1];
  const prev = cs[cs.length - 2];
  const closes = cs.map((c) => c.close);
  const highs = cs.map((c) => c.high);
  const lows = cs.map((c) => c.low);
  const vols = cs.map((c) => c.volume);

  const r = Math.max(1e-9, last.high - last.low);
  const body_pct = Math.abs(last.close - last.open) / r;
  const wickiness =
    (last.high - Math.max(last.open, last.close) + (Math.min(last.open, last.close) - last.low)) /
    r;

  // RSI (Wilder simple)
  const period = 14;
  let gain = 0,
    loss = 0;
  for (let i = cs.length - period; i < cs.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain += Math.max(0, d);
    loss += Math.max(0, -d);
  }
  const rs = loss > 0 ? gain / period / (loss / period) : 99;
  const rsi = 100 - 100 / (1 + rs);

  const ema25 = ema(closes, 25);
  const emaSlope =
    (ema25[ema25.length - 1] - ema25[ema25.length - 9]) / Math.max(1e-9, ema25[ema25.length - 9]);

  const tr = Math.max(
    last.high - last.low,
    Math.abs(last.high - prev.close),
    Math.abs(last.low - prev.close),
  );
  const atr = (() => {
    let sum = 0;
    for (let i = cs.length - 14; i < cs.length; i++) {
      const c = cs[i],
        p = cs[i - 1];
      sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    return sum / 14;
  })();
  const atr_pct = atr / Math.max(1e-9, last.close);

  const volAvg20 =
    vols.slice(-21, -1).reduce((s, v) => s + v, 0) / Math.max(1, vols.slice(-21, -1).length);
  const vol_ratio = volAvg20 > 0 ? last.volume / volAvg20 : 1;

  const mom3 = closes[closes.length - 1] / closes[closes.length - 4] - 1;
  const mom12 = closes[closes.length - 1] / closes[closes.length - 13] - 1;

  return { rsi, ema_slope: emaSlope, atr_pct, vol_ratio, body_pct, wickiness, mom3, mom12 };
}
