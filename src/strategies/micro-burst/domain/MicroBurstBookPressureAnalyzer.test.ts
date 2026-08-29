import { describe, expect, it } from 'vitest';
import {
  analyzeBookPressure,
  isBookHealthy,
  validateOrderBookSnapshot,
} from './MicroBurstBookPressureAnalyzer';
import { OrderBookSnapshot } from './MicroBurstTypes';
import { TemporalBookSnapshot } from './MicroBurstMarketDataTypes';

const SNAPSHOT_AT_MS = 1_700_000_000_000;

function book(overrides: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot {
  return {
    bidDepth: [
      { price: 100, qty: 10 },
      { price: 99.9, qty: 10 },
    ],
    askDepth: [
      { price: 100.05, qty: 10 },
      { price: 100.1, qty: 10 },
    ],
    observedAtMs: SNAPSHOT_AT_MS - 1_000,
    status: 'HEALTHY',
    ...overrides,
  };
}

describe('MicroBurstBookPressureAnalyzer status contract', () => {
  it('uses HEALTHY only for valid, fresh, non-anomalous snapshots', () => {
    const signal = analyzeBookPressure(book(), SNAPSHOT_AT_MS);
    expect(signal).toMatchObject({ status: 'HEALTHY', anomalyFlag: false });
    expect(isBookHealthy(signal)).toBe(true);
  });

  it('keeps directional imbalance separate from book anomalies', () => {
    const spread = analyzeBookPressure(
      book({ askDepth: [{ price: 101, qty: 10 }] }),
      SNAPSHOT_AT_MS,
    );
    expect(spread).toMatchObject({ status: 'ANOMALOUS', anomalyFlag: true });
    expect(isBookHealthy(spread)).toBe(false);

    const imbalance = analyzeBookPressure(
      book({ bidDepth: [{ price: 100, qty: 100 }], askDepth: [{ price: 100.05, qty: 1 }] }),
      SNAPSHOT_AT_MS,
    );
    expect(imbalance).toMatchObject({
      status: 'HEALTHY',
      anomalyFlag: false,
      signedTopOfBookImbalance: expect.closeTo(0.98),
      topOfBookImbalance: expect.closeTo(0.98),
    });
  });

  it('uses only causal temporal observations for signed imbalance slope', () => {
    const history: TemporalBookSnapshot[] = [
      {
        observedAtMs: SNAPSHOT_AT_MS - 4_000,
        signedTopOfBookImbalance: 0.4,
        topOfBookImbalance: 0.4,
        bestBidQty: 1,
        bestAskQty: 2,
        bidTop5Qty: 1,
        askTop5Qty: 2,
        spreadBps: 5,
      },
      {
        observedAtMs: SNAPSHOT_AT_MS - 3_000,
        signedTopOfBookImbalance: 0.2,
        topOfBookImbalance: 0.2,
        bestBidQty: 1,
        bestAskQty: 2,
        bidTop5Qty: 1,
        askTop5Qty: 2,
        spreadBps: 5,
      },
      {
        observedAtMs: SNAPSHOT_AT_MS + 1,
        signedTopOfBookImbalance: -1,
        topOfBookImbalance: 1,
        bestBidQty: 1,
        bestAskQty: 2,
        bidTop5Qty: 1,
        askTop5Qty: 2,
        spreadBps: 5,
      },
    ];
    const signal = analyzeBookPressure(
      book(),
      SNAPSHOT_AT_MS,
      { minTemporalObservations: 2 },
      history,
    );
    expect(signal.imbalanceSlope).toBeCloseTo(-0.2);
  });

  it('propagates provider UNSYNCED instead of inventing HEALTHY', () => {
    const signal = analyzeBookPressure(book({ status: 'UNSYNCED' }), SNAPSHOT_AT_MS);
    expect(signal.status).toBe('UNSYNCED');
    expect(isBookHealthy(signal)).toBe(false);
  });

  it('marks an old provider observation STALE', () => {
    const signal = analyzeBookPressure(
      book({ observedAtMs: SNAPSHOT_AT_MS - 30_001 }),
      SNAPSHOT_AT_MS,
    );
    expect(signal.status).toBe('STALE');
  });

  it.each([
    ['empty bids', book({ bidDepth: [] })],
    ['empty asks', book({ askDepth: [] })],
    ['crossed book', book({ bidDepth: [{ price: 101, qty: 1 }] })],
    ['non-finite price', book({ bidDepth: [{ price: Number.NaN, qty: 1 }] })],
    ['negative quantity', book({ askDepth: [{ price: 100.05, qty: -1 }] })],
    [
      'unsorted bids',
      book({
        bidDepth: [
          { price: 99.9, qty: 1 },
          { price: 100, qty: 1 },
        ],
      }),
    ],
    [
      'unsorted asks',
      book({
        askDepth: [
          { price: 100.1, qty: 1 },
          { price: 100.05, qty: 1 },
        ],
      }),
    ],
  ] as const)('rejects %s as UNSYNCED', (_name, snapshot) => {
    expect(validateOrderBookSnapshot(snapshot)).toBe('UNSYNCED');
    expect(analyzeBookPressure(snapshot, SNAPSHOT_AT_MS).status).toBe('UNSYNCED');
  });

  it('returns UNAVAILABLE without a snapshot', () => {
    expect(analyzeBookPressure(undefined, SNAPSHOT_AT_MS).status).toBe('UNAVAILABLE');
  });
});
