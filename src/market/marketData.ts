import { Candle } from '../types';
import { binanceClient } from '../api/binanceClient';

const AVERAGE_LENGTH = 10;
const INTERVAL = '1m';

export async function getRecentCandles(symbol: string = 'XRPUSDT'): Promise<Candle[]> {
  try {
    const rawCandles = await binanceClient.futuresCandles({
      symbol,
      interval: INTERVAL,
      limit: AVERAGE_LENGTH + 1,
    });

    return rawCandles.map((candle) => ({
      openTime: new Date(candle.openTime).getTime(),
      open: parseFloat(candle.open),
      high: parseFloat(candle.high),
      low: parseFloat(candle.low),
      close: parseFloat(candle.close),
      volume: parseFloat(candle.volume),
      closeTime: new Date(candle.closeTime).getTime(),
    }));
  } catch (error) {
    console.error('❌ Error al obtener velas:', error);
    return [];
  }
}

export function isGreenCandle(candle: Candle): boolean {
  return candle.close > candle.open;
}

export function isVolumeAboveAverage(latestVolume: number, previousVolumes: number[]): boolean {
  const average =
    previousVolumes.reduce((sum, volume) => sum + volume, 0) / (previousVolumes.length || 1);
  return latestVolume > average;
}
