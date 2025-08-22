// src/strategy/reverseDetector.ts
import { getRecentCandles, isVolumeAboveAverage } from '../market/marketData';

export async function isReverseSignal(symbol: string = 'XRPUSDT'): Promise<boolean> {
  const candles = await getRecentCandles(symbol);
  console.log(candles);
  if (candles.length < 2) return false;

  const latest = candles[candles.length - 1];
  const previousVolumes = candles.slice(0, -1).map((c) => c.volume);

  const isRed = latest.close < latest.open;
  const lowVolume = !isVolumeAboveAverage(latest.volume, previousVolumes);

  return isRed && lowVolume;
}
