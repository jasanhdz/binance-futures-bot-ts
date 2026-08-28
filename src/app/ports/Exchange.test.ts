import { describe, expect, it } from 'vitest';
import { Exchange, MarketDataPort, TradingExchangePort } from './Exchange';

describe('exchange capability ports', () => {
  it('keeps market-data consumers statically free of mutations', () => {
    const marketData = {} as MarketDataPort;
    expect(marketData).toBeDefined();
    // @ts-expect-error MarketDataPort must not expose trading mutations.
    marketData.marketOpen;
    // @ts-expect-error MarketDataPort must not expose account/order mutations.
    marketData.setLeverage;
  });

  it('retains the execution capability and compatibility composite', () => {
    const trading = {} as TradingExchangePort;
    const legacy = {} as Exchange;
    expect(trading).toBeDefined();
    expect(legacy).toBeDefined();
  });
});
