import type { RawCandleEvent } from './ScoutMarketDataRuntime';
import { RingBuffer } from './ScoutMarketDataRuntime';

export interface BuiltCandle {
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly buyVolume: number;
  readonly closeTime: number;
  readonly interval: string;
  readonly isClosed: boolean;
  readonly candleCount: number;
}

export interface ThreeMinuteCandleBuilder {
  onCandle(event: RawCandleEvent): BuiltCandle | null;
  getRecentCandles(interval: string, count: number): BuiltCandle[];
  getAtr(interval: string, period: number): number;
  clear(): void;
}

export function createThreeMinuteCandleBuilder(): ThreeMinuteCandleBuilder {
  const candles1m = new RingBuffer<BuiltCandle>(240);
  const candles3m = new RingBuffer<BuiltCandle>(240);
  const openCandles3m = new Map<number, BuiltCandle>();

  function build1m(event: RawCandleEvent): BuiltCandle {
    return {
      openTime: event.openTime,
      open: event.open,
      high: event.high,
      low: event.low,
      close: event.close,
      volume: event.volume,
      buyVolume: event.volume * 0.5,
      closeTime: event.closeTime,
      interval: '1m',
      isClosed: event.isClosed,
      candleCount: 1,
    };
  }

  function aggregateInto3m(candle: BuiltCandle): BuiltCandle | null {
    const bucketStart = Math.floor(candle.openTime / 180_000) * 180_000;
    const existing = openCandles3m.get(bucketStart);

    if (existing && !existing.isClosed) {
      const merged: BuiltCandle = {
        openTime: existing.openTime,
        open: existing.open,
        high: Math.max(existing.high, candle.high),
        low: Math.min(existing.low, candle.low),
        close: candle.close,
        volume: existing.volume + candle.volume,
        buyVolume: existing.buyVolume + candle.buyVolume,
        closeTime: candle.closeTime,
        interval: '3m',
        isClosed: candle.closeTime >= bucketStart + 180_000 - 1,
        candleCount: existing.candleCount + 1,
      };

      if (merged.isClosed) {
        openCandles3m.delete(bucketStart);
        candles3m.push(merged);
        return merged;
      }
      openCandles3m.set(bucketStart, merged);
      return null;
    }

    const newCandle: BuiltCandle = {
      openTime: bucketStart,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      buyVolume: candle.buyVolume,
      closeTime: candle.closeTime,
      interval: '3m',
      isClosed: candle.closeTime >= bucketStart + 180_000 - 1,
      candleCount: 1,
    };

    if (newCandle.isClosed) {
      candles3m.push(newCandle);
      return newCandle;
    }
    openCandles3m.set(bucketStart, newCandle);
    return null;
  }

  function calcAtr(buffer: RingBuffer<BuiltCandle>, period: number): number {
    const all = buffer.items();
    if (all.length < 2) return 0;
    const trs: number[] = [];
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      trs.push(tr);
    }
    if (trs.length === 0) return 0;
    const slice = trs.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  return {
    onCandle(event: RawCandleEvent): BuiltCandle | null {
      if (event.symbol !== 'SUIUSDT') return null;

      const built = build1m(event);
      candles1m.push(built);

      if (event.isClosed) {
        return aggregateInto3m(built);
      }
      return null;
    },

    getRecentCandles(interval: string, count: number): BuiltCandle[] {
      const buf = interval === '3m' ? candles3m : candles1m;
      const items = buf.items();
      return items.slice(-count);
    },

    getAtr(interval: string, period: number): number {
      const buf = interval === '3m' ? candles3m : candles1m;
      return calcAtr(buf, period);
    },

    clear(): void {
      candles1m.clear();
      candles3m.clear();
      openCandles3m.clear();
    },
  };
}
