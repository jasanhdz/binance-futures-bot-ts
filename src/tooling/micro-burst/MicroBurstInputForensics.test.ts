import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { Candle } from '../../core/types';
import {
  makeMicroBurstContext,
  TEST_SNAPSHOT_AT_MS as now,
} from '../../strategies/micro-burst/domain/MicroBurst.test-support';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import { captureMicroBurstReplay } from '../../strategies/micro-burst/domain/MicroBurstExactReplay';
import {
  btcTimeline,
  candleFingerprint,
  scanStableJsonl,
  unreachedGuardFacts,
} from './MicroBurstInputForensics';
import { summarizePatternCohorts } from './MicroBurstPatternCohorts';
import { BtcMicroContextProvider } from '../../strategies/micro-burst/domain/BtcMicroContextProvider';
import { MarketDataCandleProvider } from '../../core/market-data/MarketDataCandleProvider';

describe('offline input forensics', () => {
  const candle: Candle = {
    timestamp: now - 59_999,
    openTime: now - 59_999,
    closeTime: now,
    open: 1.3534,
    high: 1.3538,
    low: 1.3534,
    close: 1.3537,
    volume: 52832.8,
    buyVolume: 35063,
  };
  it('separates property-order normalization from actual price/volume changes', () => {
    const reordered = Object.fromEntries(Object.entries(candle).reverse()) as unknown as Candle;
    expect(candleFingerprint(reordered).jsonSha256).not.toBe(candleFingerprint(candle).jsonSha256);
    expect(candleFingerprint(reordered).canonicalSha256).toBe(
      candleFingerprint(candle).canonicalSha256,
    );
    expect(candleFingerprint(reordered).numericalSha256).toBe(
      candleFingerprint(candle).numericalSha256,
    );
    for (const change of [{ close: 1.3538 }, { volume: 52927.1 }, { buyVolume: 35073.2 }])
      expect(candleFingerprint({ ...candle, ...change }).numericalSha256).not.toBe(
        candleFingerprint(candle).numericalSha256,
      );
  });
  function replay() {
    const context = makeMicroBurstContext();
    context.btcContext!.observedAtMs = now - 64_140;
    context.btcContext!.receivedAtMs = now - 52_000;
    return captureMicroBurstReplay(
      {
        ...context,
        observedAtMs: now,
        exchangeObservedAtMs: now + 100,
        clockReference: {
          source: 'SERVER_REQUEST_RESPONSE_BOUND',
          serverSampleAtMs: now,
          localRequestStartedAtMs: now - 500,
          localResponseReceivedAtMs: now,
          requestRoundTripMs: 500,
          contextBuiltExchangeLowerBoundMs: now,
          contextBuiltExchangeUpperBoundMs: now + 500,
        },
      },
      defaultMicroBurstConfig(),
      'a'.repeat(40),
    );
  }
  it('keeps event and receive clocks distinct, preserving unknown packet/poll timestamps', () => {
    const input = structuredClone(replay());
    expect(btcTimeline(input)).toMatchObject({
      eventAgeAtSnapshotMs: 64140,
      eventAgeAtDecisionUpperBoundMs: 64240,
      eventAgeAtContextBuiltLowerBoundMs: 64140,
      providerReceiveAgeAtDecisionMs: 52000,
      btcSourcePacketReceivedAtMs: null,
      btcPollRequestedAtMs: null,
    });
    input.context.btcContext = null;
    expect(btcTimeline(input)).toMatchObject({
      providerReceiveAgeAtDecisionMs: null,
      eventAgeAtSnapshotMs: null,
      receivedTimestampMeaning: 'UNKNOWN',
    });
  });
  it('reports unreached predicates without mutating input or returning an entry verdict', () => {
    const input = structuredClone(replay());
    input.context.momentum.direction = 'NEUTRAL';
    const before = structuredClone(input);
    const result = unreachedGuardFacts(input, 'LONG');
    expect(result).toMatchObject({
      momentumMatchesCandidate: false,
      authority: 'DIAGNOSTIC_ONLY_NO_GUARDS_BYPASSED_NO_ENTRY_VERDICT',
    });
    expect(result).not.toHaveProperty('action');
    expect(input).toEqual(before);
  });
  it('hashes stable gzip bytes, preserves source line numbers and counts malformed lines', async () => {
    const directory = mkdtempSync('/tmp/opencode/micro-forensics-test-');
    try {
      const file = join(directory, 'sample.jsonl.gz');
      writeFileSync(file, gzipSync('{"x":1}\ninvalid\n{"x":2}\n'));
      const lines: number[] = [];
      const result = await scanStableJsonl(file, (_value, line) => {
        lines.push(line);
      });
      expect(result).toMatchObject({ lines: 3, malformed: 1, rotated: true });
      expect(lines).toEqual([1, 3]);
      expect(String(result.sha256)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it('rejects changed files rather than treating a partial read as stable', async () => {
    const directory = mkdtempSync('/tmp/opencode/micro-forensics-test-');
    try {
      const file = join(directory, 'sample.jsonl');
      writeFileSync(file, '{"x":1}\n');
      await expect(
        scanStableJsonl(file, (_value, line) => {
          if (line === 1) appendFileSync(file, '{"x":2}\n');
        }),
      ).rejects.toThrow('FORENSIC_SOURCE_CHANGED');
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it('reproduces elapsed-read latency in BTC boundary scheduling without changing the provider', async () => {
    vi.useFakeTimers();
    const boundary = Math.floor(now / 60_000) * 60_000;
    vi.setSystemTime(boundary + 30_000);
    const started: number[] = [];
    const clock = { now: () => Date.now() };
    const market = new MarketDataCandleProvider(
      {
        getServerTime: async () => {
          started.push(Date.now());
          return Date.now();
        },
        getCandles: async () => {
          const latestClose = Math.floor(Date.now() / 60_000) * 60_000 - 1;
          await new Promise((done) => setTimeout(done, 6000));
          return Array.from({ length: 8 }, (_, i) => ({
            ...candle,
            openTime: latestClose - (7 - i) * 60_000 - 59_999,
            timestamp: latestClose - (7 - i) * 60_000 - 59_999,
            closeTime: latestClose - (7 - i) * 60_000,
          }));
        },
      },
      clock,
    );
    const provider = new BtcMicroContextProvider(
      'BTCUSDT',
      {
        benchmark: {
          descriptor: { id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'BTCUSDT' },
          candles: { getSeries: (interval, limit) => market.getSeries('BTCUSDT', interval, limit) },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
      clock,
    );
    try {
      provider.start();
      await vi.advanceTimersByTimeAsync(36_249);
      expect(started).toEqual([boundary + 30_000, boundary + 60_250]);
      expect(provider.getBtcContext()!.observedAtMs).toBe(boundary - 1);
      expect(Date.now() - provider.getBtcContext()!.observedAtMs).toBeGreaterThan(60_000);
      await vi.advanceTimersByTimeAsync(24_001);
      expect(started).toEqual([boundary + 30_000, boundary + 60_250]);
      await vi.advanceTimersByTimeAsync(6000);
      expect(provider.getBtcContext()!.observedAtMs).toBe(boundary + 59_999);
      expect(provider.getBtcContext()!.receivedAtMs).toBe(boundary + 66_250);
    } finally {
      provider.stop();
      vi.useRealTimers();
    }
  });
});

describe('explicit cohort boundaries', () => {
  const report = (hash: string, config = 'same') => ({
    provenance: {
      compressedSha256: hash,
      baselineVerified: true,
      configSha256BySymbol: { SOLUSDT: config },
    },
    counts: {},
    totals: {},
    newPatternEpisodeIntervalOverlapPairs: [],
  });
  it('does not aggregate independent episode counts across reset cohorts', () => {
    const result = summarizePatternCohorts([report('a'), report('b')]);
    expect(result).not.toHaveProperty('combinedTotals');
    expect(result.summaries).toHaveLength(2);
    expect(result.stateBoundary).toContain('independent cohort');
  });
  it('rejects duplicate sources, changed thresholds and unverified baselines', () => {
    expect(() => summarizePatternCohorts([report('a'), report('a')])).toThrow('DUPLICATE_SOURCE');
    expect(() => summarizePatternCohorts([report('a'), report('b', 'different')])).toThrow(
      'THRESHOLD_INCOMPATIBLE',
    );
    const invalid = report('b');
    invalid.provenance.baselineVerified = false;
    expect(() => summarizePatternCohorts([report('a'), invalid])).toThrow(
      'BASELINE_OR_THRESHOLD_INCOMPATIBLE',
    );
  });
});
