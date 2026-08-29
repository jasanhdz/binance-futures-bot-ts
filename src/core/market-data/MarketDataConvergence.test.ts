import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DepthStreamGapDetector } from './DepthStreamGapDetector';
import { ServerOffsetEstimator, eventAgeMs } from './MarketDataClocks';
import { parseAggTrade, parseDepth } from './NormalizedMarketEvents';

const srcRoot = resolve(__dirname, '../..');

function source(path: string): string {
  return readFileSync(resolve(srcRoot, path), 'utf8');
}

describe('Phase R market-data convergence', () => {
  it('keeps normalized parser behavior in the shared core', () => {
    expect(
      parseAggTrade(
        'ETHUSDT',
        { E: 90, T: 100, p: '123.5', q: '2', m: false, a: 7, f: 8, l: 9 },
        110,
      ),
    ).toEqual({
      feed: 'AGG_TRADE',
      symbol: 'ETHUSDT',
      eventTimeMs: 100,
      receivedAtMs: 110,
      price: 123.5,
      quantity: 2,
      isBuyerMaker: false,
      aggregateTradeId: 7,
      firstTradeId: 8,
      lastTradeId: 9,
      tradeTimeMs: 100,
    });
    expect(
      parseDepth(
        'ETHUSDT',
        { E: 100, T: 101, U: 10, u: 12, pu: 9, b: [['100', '2']], a: [['101', '3']] },
        110,
      ),
    ).toMatchObject({
      feed: 'DEPTH',
      symbol: 'ETHUSDT',
      firstUpdateId: 10,
      finalUpdateId: 12,
      previousFinalUpdateId: 9,
      eventTimeMs: 100,
      transactionTimeMs: 101,
      receivedAtMs: 110,
    });
  });

  it('keeps generic clocks and gap detection independent from Micro Burst', () => {
    const estimator = new ServerOffsetEstimator();
    estimator.observe(1_050, 1_000, 1_020);
    expect(estimator.estimate()).toEqual({ offsetMs: 40, uncertaintyMs: 0, samples: 1 });
    expect(eventAgeMs(1_200, 1_100, estimator.estimate())).toBe(140);

    const gaps: unknown[] = [];
    const detector = new DepthStreamGapDetector((gap) => gaps.push(gap));
    detector.seedSnapshot(10);
    expect(
      detector.accept({
        feed: 'DEPTH',
        symbol: 'ETHUSDT',
        eventTimeMs: 100,
        receivedAtMs: 101,
        firstUpdateId: 10,
        finalUpdateId: 11,
        previousFinalUpdateId: 9,
        bids: [],
        asks: [],
      }),
    ).toBe('ACCEPT');
    expect(
      detector.accept({
        feed: 'DEPTH',
        symbol: 'ETHUSDT',
        eventTimeMs: 102,
        receivedAtMs: 103,
        firstUpdateId: 13,
        finalUpdateId: 13,
        previousFinalUpdateId: 12,
        bids: [],
        asks: [],
      }),
    ).toBe('GAP');
    expect(gaps).toHaveLength(1);
  });

  it('removes obsolete app-level Micro Burst market-data compatibility shims', () => {
    for (const legacyPath of [
      'app/micro-burst/MicroBurstClocks.ts',
      'app/micro-burst/MicroBurstMarketData.ts',
      'app/micro-burst/MicroBurstStreamGapDetector.ts',
    ]) {
      expect(existsSync(resolve(srcRoot, legacyPath)), legacyPath).toBe(false);
    }
  });

  it('keeps generic transport independent from Micro Burst application files', () => {
    const websocketManager = source('infra/adapters/WebSocketManager.ts');
    expect(websocketManager).toContain(
      "from '../../core/market-data/NormalizedMarketEvents';",
    );
    expect(websocketManager).not.toContain('app/micro-burst/MicroBurstMarketData');
  });

  it('keeps the order-book compatibility adapter free of synchronization mechanics', () => {
    const compatibility = source('strategies/micro-burst/domain/SynchronizedOrderBook.ts');
    expect(compatibility).toContain('extends SharedSynchronizedOrderBook');
    for (const forbidden of ['diffBuffer', 'syncFromSnapshot', 'handleDiff', 'applyDiff']) {
      expect(compatibility).not.toContain(forbidden);
    }
  });

  it('keeps shared market-data production files free of concrete strategy imports', () => {
    const marketDataDir = resolve(srcRoot, 'core/market-data');
    const production = readdirSync(marketDataDir)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
      .map((name) => readFileSync(resolve(marketDataDir, name), 'utf8'))
      .join('\n');
    expect(production).not.toContain('/strategies/micro-burst/');
    expect(production).not.toContain('/app/micro-burst/');
  });
});
