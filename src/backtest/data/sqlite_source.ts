import Database from 'better-sqlite3';
import path from 'path';
import { Candle } from '../../core/types';
import { timeframeToMs } from '../timeframe';

type CandleRow = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type MarketRow = {
  timestamp: string;
  funding_rate: number | null;
  mark_price: number | null;
  index_price: number | null;
};

export type SqliteSourceOptions = {
  dbPath: string;
};

export type FundingSnapshot = {
  time: number;
  rate: number;
  nextFundingTime?: number;
};

export type BasisSnapshot = {
  time: number;
  markPrice: number;
  indexPrice: number;
  basisPct: number;
};

const ensureAbsolutePath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p));

function parseTimestamp(ts: string): number {
  // Stored as 'YYYY-MM-DD HH:MM:SS.mmmmmm'. Interpret as UTC.
  const normalized = ts.endsWith('Z') ? ts : `${ts.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) {
    throw new Error(`Unable to parse timestamp "${ts}"`);
  }
  return ms;
}

function binarySearchLastLE(series: number[], target: number): number {
  let lo = 0;
  let hi = series.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const value = series[mid];
    if (value <= target) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export class SqliteHistoricalSource {
  private db: Database.Database;
  private candleCache = new Map<string, Candle[]>();
  private candleTimes = new Map<string, number[]>();
  private fundingSeries = new Map<string, FundingSnapshot[]>();
  private basisSeries = new Map<string, BasisSnapshot[]>();

  constructor(opts: SqliteSourceOptions) {
    const dbPath = ensureAbsolutePath(opts.dbPath);
    this.db = new Database(dbPath, { readonly: true });
  }

  close() {
    this.db.close();
  }

  loadCandles(symbol: string, timeframe: string): Candle[] {
    const key = `${symbol}|${timeframe}`;
    const cached = this.candleCache.get(key);
    if (cached) {
      return cached;
    }
    const duration = timeframeToMs(timeframe);
    const stmt = this.db.prepare<CandleRow>(
      `SELECT timestamp, open, high, low, close, volume
       FROM ohlcv_data
       WHERE symbol = ? AND timeframe = ?
       ORDER BY timestamp ASC`,
    );
    const rows = stmt.all(symbol, timeframe);
    const candles = rows.map((row) => {
      const openTime = parseTimestamp(row.timestamp);
      return {
        openTime,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        closeTime: openTime + duration,
      };
    });
    const times = candles.map((c) => c.closeTime);
    this.candleCache.set(key, candles);
    this.candleTimes.set(key, times);
    return candles;
  }

  sliceCandlesUpTo(symbol: string, timeframe: string, closeTime: number, limit: number): Candle[] {
    const candles = this.loadCandles(symbol, timeframe);
    const key = `${symbol}|${timeframe}`;
    const times = this.candleTimes.get(key);
    if (!times) {
      return [];
    }
    const idx = binarySearchLastLE(times, closeTime);
    if (idx < 0) {
      return [];
    }
    const start = Math.max(0, idx - limit + 1);
    return candles.slice(start, idx + 1);
  }

  latestCandle(symbol: string, timeframe: string, closeTime: number): Candle | undefined {
    const candles = this.loadCandles(symbol, timeframe);
    const key = `${symbol}|${timeframe}`;
    const times = this.candleTimes.get(key);
    if (!times || times.length === 0) return undefined;
    const idx = binarySearchLastLE(times, closeTime);
    if (idx < 0) return undefined;
    return candles[idx];
  }

  private loadMarketSeries(symbol: string) {
    const key = symbol.toUpperCase();
    if (this.fundingSeries.has(key) && this.basisSeries.has(key)) {
      return;
    }

    const stmt = this.db.prepare<MarketRow>(
      `SELECT timestamp, funding_rate, mark_price, index_price
       FROM market_data
       WHERE symbol = ?
       ORDER BY timestamp ASC`,
    );
    const rows = stmt.all(symbol);
    const funding: FundingSnapshot[] = [];
    const basis: BasisSnapshot[] = [];
    for (const row of rows) {
      const ts = parseTimestamp(row.timestamp);
      if (row.funding_rate !== null && Number.isFinite(row.funding_rate)) {
        funding.push({
          time: ts,
          rate: row.funding_rate,
          nextFundingTime: ts + 8 * 60 * 60 * 1000,
        });
      }
      if (row.mark_price !== null && row.index_price !== null) {
        const mark = row.mark_price;
        const index = row.index_price;
        const basisPct = index > 0 ? (mark - index) / index : 0;
        basis.push({
          time: ts,
          markPrice: mark,
          indexPrice: index,
          basisPct,
        });
      }
    }
    this.fundingSeries.set(key, funding);
    this.basisSeries.set(key, basis);
  }

  fundingAt(symbol: string, closeTime: number): FundingSnapshot | null {
    this.loadMarketSeries(symbol);
    const series = this.fundingSeries.get(symbol.toUpperCase()) ?? [];
    if (!series.length) {
      return null;
    }
    const times = series.map((s) => s.time);
    const idx = binarySearchLastLE(times, closeTime);
    if (idx < 0) {
      return series[0];
    }
    return series[idx];
  }

  basisAt(symbol: string, closeTime: number): BasisSnapshot | null {
    this.loadMarketSeries(symbol);
    const series = this.basisSeries.get(symbol.toUpperCase()) ?? [];
    if (!series.length) {
      return null;
    }
    const times = series.map((s) => s.time);
    const idx = binarySearchLastLE(times, closeTime);
    if (idx < 0) {
      return series[0];
    }
    return series[idx];
  }
}
