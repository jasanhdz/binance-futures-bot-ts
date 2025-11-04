import {
  Exchange,
  BasisSnapshot as ExchangeBasisSnapshot,
  FundingSnapshot as ExchangeFundingSnapshot,
  SymbolFilters,
  PositionInfo,
  TradeFill,
} from '../core/ports/Exchange';
import { Candle, Side } from '../core/types';
import { SqliteHistoricalSource } from './data/sqlite_source';

type ConstructorOpts = {
  source: SqliteHistoricalSource;
  symbol: string;
  dataSymbol: string;
  primaryTimeframe: string;
};

export class BacktestExchange implements Exchange {
  private currentCloseTime = 0;

  constructor(private opts: ConstructorOpts) {}

  setCursor(closeTime: number) {
    this.currentCloseTime = closeTime;
  }

  async getServerTime(): Promise<number> {
    return this.currentCloseTime;
  }

  async getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    return this.opts.source.sliceCandlesUpTo(this.opts.dataSymbol, interval, this.currentCloseTime, limit);
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const candle = this.opts.source.latestCandle(
      this.opts.dataSymbol,
      this.opts.primaryTimeframe,
      this.currentCloseTime,
    );
    if (!candle) {
      throw new Error(`No candle available for ${symbol} at ${this.currentCloseTime}`);
    }
    return candle.close;
  }

  async getFundingRate(symbol: string): Promise<ExchangeFundingSnapshot> {
    const snapshot = this.opts.source.fundingAt(this.opts.dataSymbol, this.currentCloseTime);
    if (!snapshot) {
      return { rate: 0, nextFundingTime: undefined };
    }
    return {
      rate: snapshot.rate,
      nextFundingTime: snapshot.nextFundingTime,
    };
  }

  async getBasisSnapshot(symbol: string): Promise<ExchangeBasisSnapshot> {
    const snapshot = this.opts.source.basisAt(this.opts.dataSymbol, this.currentCloseTime);
    if (!snapshot) {
      const mark = await this.getMarkPrice(symbol);
      return {
        markPrice: mark,
        indexPrice: mark,
        basisPct: 0,
      };
    }
    return {
      markPrice: snapshot.markPrice,
      indexPrice: snapshot.indexPrice,
      basisPct: snapshot.basisPct,
    };
  }

  async readLiquidationPrice(symbol: string, side: Side): Promise<number | null> {
    throw new Error('readLiquidationPrice not available in backtest');
  }

  async getUSDTBalance(): Promise<number> {
    throw new Error('getUSDTBalance not available in backtest');
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    return;
  }

  async ensureMarginType(symbol: string, marginType?: 'ISOLATED' | 'CROSSED'): Promise<void> {
    return;
  }

  async getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters> {
    return {
      tickSize: 0.0001,
      stepSize: 0.01,
      pricePrecision: 4,
      qtyPrecision: 2,
      minNotional: 5,
    };
  }

  async hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean> {
    return false;
  }

  async readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null> {
    return null;
  }

  async marketOpen(symbol: string, side: Side, quantity: number): Promise<{ avgPrice: number; orderId: string }> {
    throw new Error('marketOpen not available in backtest exchange');
  }

  async placeStopClose(symbol: string, side: Side, stopPrice: number): Promise<void> {
    return;
  }

  async placeTpClose(symbol: string, side: Side, triggerPrice: number): Promise<void> {
    return;
  }

  async closeSideMarketSafe(
    symbol: string,
    side: Side,
    qtyAbs: number,
    sideMode: 'BOTH' | 'LONG' | 'SHORT',
  ): Promise<void> {
    return;
  }

  async openStopForSide(symbol: string, side: Side): Promise<{ stopPrice: number; orderId: string } | null> {
    return null;
  }

  async cancelOrderById(symbol: string, orderId: string): Promise<void> {
    return;
  }

  async getRecentFills(symbol: string, startTime?: number, limit?: number): Promise<TradeFill[]> {
    return [];
  }
}
