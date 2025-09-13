// src/backtest/offlineExchange.ts
import { Exchange, PositionInfo, SymbolFilters } from '../core/ports/Exchange';
import { Candle, Side } from '../core/types';

export class OfflineExchange implements Exchange {
  private i = 0;
  constructor(
    private candles: Candle[],
    private symbol: string,
    private interval: string,
  ) {}

  setIndex(i: number) {
    this.i = i;
  }

  async getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    if (symbol !== this.symbol || interval !== this.interval) {
      // devolvemos igualmente la ventana del símbolo cargado
    }
    const end = Math.min(this.i + 1, this.candles.length);
    const start = Math.max(0, end - limit);
    return this.candles.slice(start, end);
  }

  async getMarkPrice(): Promise<number> {
    return this.candles[this.i]?.close ?? NaN;
  }

  // ===== Métodos no usados por evaluate en backtest (stubs seguros) =====
  async getServerTime() {
    return Date.now();
  }
  async readLiquidationPrice(): Promise<number | null> {
    return null;
  }
  async getUSDTBalance(): Promise<number> {
    return 0;
  }
  async setLeverage(): Promise<void> {
    return;
  }
  async getSymbolFilters(): Promise<SymbolFilters> {
    return { tickSize: 0.0001, stepSize: 0.1, pricePrecision: 4, qtyPrecision: 1, minNotional: 5 };
  }
  async hasOpenPosition(): Promise<boolean> {
    return false;
  }
  async readActivePosition(): Promise<PositionInfo | null> {
    return null;
  }
  async marketOpen(): Promise<{ avgPrice: number; orderId: string }> {
    throw new Error('Not in BT');
  }
  async placeStopClose(): Promise<void> {
    return;
  }
  async placeTpClose(): Promise<void> {
    return;
  }
  async closeSideMarketSafe(): Promise<void> {
    return;
  }
  async openStopForSide(): Promise<{ stopPrice: number; orderId: string } | null> {
    return null;
  }
  async cancelOrderById(): Promise<void> {
    return;
  }
  async cancelOrdersByIds(): Promise<void> {
    return;
  }
}
