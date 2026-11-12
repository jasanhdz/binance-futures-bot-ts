import { expect, it, vi } from 'vitest';
import { createReadOnlyBinanceMarketData } from '../../infra/adapters/ReadOnlyBinanceMarketData';
import type { Logger } from '../../app/ports/Logger';
import type { MarketDataPort } from '../../app/ports/MarketData';
import type { MicroBurstRuntimeConfig } from '../../strategies/micro-burst/application/MicroBurstRuntimeTypes';
import {
  buildEffectiveCaptureConfiguration,
  composeCaptureObservationRuntime,
  runContinuousCollector,
  wrapPublicMarketDataForCapture,
} from './MicroBurstContinuousCollector';

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

it('records monotonic REST receipt without normalizing a regressing local wall clock', async () => {
  const records: Record<string, unknown>[] = [];
  const localWallTimes = [1_000, 900];
  const response = [{ openTime: 0, closeTime: 59_999 }];
  const source = { getCandles: vi.fn(async () => response) } as unknown as MarketDataPort;
  const wrapped = wrapPublicMarketDataForCapture(
    source,
    (record) => records.push(record),
    () => undefined,
    () => undefined,
    () => localWallTimes.shift() ?? 900,
  );

  await wrapped.getCandles('ETHUSDT', '1m', 1);
  expect(records[0]).toMatchObject({
    requestedAtMs: 1_000,
    receivedAtMs: 900,
    response,
  });
  expect(Number(records[0].receivedAtMonotonicMs)).toBeGreaterThanOrEqual(
    Number(records[0].requestedAtMonotonicMs),
  );
});

it('forces capture activation separately from the operational enable and mode fields', () => {
  const prepared = buildEffectiveCaptureConfiguration(
    {
      micro_burst: {
        enabled: false,
        mode: 'OFF',
        symbols: { BTCUSDT: { enabled: true } },
        exit_policy: { exit_max_hold_ms: 300_000 },
      },
    },
    'b'.repeat(64),
    '/tmp/capture-output',
    420,
  );
  expect(prepared.config).toMatchObject({
    enabled: true,
    mode: 'SHADOW',
    symbols: { SOLUSDT: { enabled: true }, AVAXUSDT: { enabled: true } },
    prospectiveValidation: { enabled: false },
    exitPolicy: { exitMaxHoldMs: 300_000 },
  });
  expect(prepared.effectiveConfig).toMatchObject({
    activation: 'EXPLICIT_CAPTURE_SHADOW_OVERRIDE',
    symbols: ['SOLUSDT', 'AVAXUSDT'],
    benchmarkSymbols: ['BTCUSDT'],
    requestedDurationSeconds: 420,
  });
});

it('enforces a bounded public observation duration before touching the producer root', async () => {
  await expect(runContinuousCollector('/path/that/must/not/be-opened', 86_400)).rejects.toThrow(
    'COLLECTOR_DURATION_MUST_BE_360_TO_1200_SECONDS',
  );
});

it('composes the capture runtime with the real read-only factory and a simulated public transport', async () => {
  const calls: string[] = [];
  const simulated = {
    getServerTime: vi.fn(async () => {
      calls.push('getServerTime');
      return Date.now();
    }),
    getCandles: vi.fn(async () => {
      calls.push('getCandles');
      return [];
    }),
    getLastCandle: vi.fn(async () => null),
    subscribeToCandles: vi.fn(() => () => {}),
    getMarkPrice: vi.fn(async () => 100),
    getFundingRate: vi.fn(async () => ({ rate: 0 })),
    getBasisSnapshot: vi.fn(async () => ({ markPrice: 100, indexPrice: 100, basisPct: 0 })),
    getDepthSnapshot: vi.fn(async () => {
      calls.push('getDepthSnapshot');
      return { lastUpdateId: 0, bids: [], asks: [] };
    }),
    subscribeToDepthDiff: vi.fn(() => () => {}),
    subscribeToAggTrades: vi.fn(() => () => {}),
    disconnectAll: vi.fn(() => calls.push('disconnectAll')),
  } as any;
  const codeCommitSha = 'a'.repeat(40);
  const market = createReadOnlyBinanceMarketData(logger, codeCommitSha, () => simulated);
  const rawRestRecords: Record<string, unknown>[] = [];
  let requestsInFlight = 0;
  const exchange = wrapPublicMarketDataForCapture(
    market.exchange,
    (entry) => rawRestRecords.push(entry),
    () => requestsInFlight++,
    () => requestsInFlight--,
  );
  const config: MicroBurstRuntimeConfig = {
    enabled: true,
    mode: 'SHADOW',
    symbols: { SOLUSDT: { enabled: true }, AVAXUSDT: { enabled: true } },
    marketArchive: { enabled: false },
    prospectiveValidation: { enabled: false },
  };
  const runtime = composeCaptureObservationRuntime({
    config,
    producer: { gitCommit: codeCommitSha },
    configHash: 'sha256:offline-test',
    signalJournalDir: '/tmp/micro-capture-composition-test-signals',
    runtimeDeps: {
      exchange,
      logger,
      clock: { now: Date.now },
      mutationAudit: () => ({
        totalMutationAttempts: market.audit.totalMutationAttempts,
        forwardedMutationCalls: market.audit.forwardedMutationCalls,
      }),
    },
  });
  try {
    expect(Reflect.has(market.exchange, 'marketOpen')).toBe(false);
    expect(Reflect.has(market.exchange, 'getUSDTBalance')).toBe(false);
    await runtime.start();
    await runtime.stop();
    expect(calls).toContain('getServerTime');
    expect(calls).toContain('getCandles');
    expect(calls).toContain('getDepthSnapshot');
    expect(rawRestRecords.length).toBeGreaterThan(0);
    expect(rawRestRecords.every((record) => typeof record.method === 'string')).toBe(true);
    expect(
      rawRestRecords.every(
        (record) =>
          typeof record.requestedAtMonotonicMs === 'number' &&
          typeof record.receivedAtMonotonicMs === 'number' &&
          Number(record.receivedAtMonotonicMs) >= Number(record.requestedAtMonotonicMs),
      ),
    ).toBe(true);
    expect(requestsInFlight).toBe(0);
    expect(market.audit.totalMutationAttempts).toBe(0);
    expect(market.audit.forwardedMutationCalls).toBe(0);
    expect(runtime.getHealth()).toMatchObject({
      liveExecution: false,
      paperTradingEnabled: false,
      paperTrading: { openPositions: 0, completedManagedTrades: 0 },
    });
  } finally {
    market.disconnectAll();
  }
});
