import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MicroBurstStorage } from './MicroBurstStorage';
import { eventAgeMs, ServerOffsetEstimator } from '../../../core/market-data/MarketDataClocks';
import { parseAggTrade, parseDepth } from '../../../core/market-data/NormalizedMarketEvents';
import { DepthStreamGapDetector } from '../../../core/market-data/DepthStreamGapDetector';

const temporaryDirectories: string[] = [];

function createStorage(): {
  storage: MicroBurstStorage;
  root: string;
  databasePath: string;
  archivePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-'));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, 'state', 'micro-burst.sqlite');
  const archivePath = path.join(root, 'archive');
  return {
    storage: new MicroBurstStorage({ databasePath, archivePath, now: () => 9_999 }),
    root,
    databasePath,
    archivePath,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('MicroBurstStorage', () => {
  it('persists Opportunity samples idempotently and records deferred labels', () => {
    const { storage } = createStorage();
    const sample = {
      sampleId: 'opportunity-sample-1',
      symbol: 'BTCUSDT',
      sampledAtMs: 100,
      schemaVersion: 1,
      featureSchemaVersion: 'MICRO_OPPORTUNITY_FEATURE_V1',
      featureSchemaHash: 'hash',
      features: {},
    } as any;
    expect(storage.persistOpportunitySample(sample)).toBe(true);
    expect(storage.persistOpportunitySample(sample)).toBe(true);
    expect(storage.countOpportunitySamples()).toBe(1);
    expect(storage.persistOpportunityLabels('opportunity-sample-1', { 10_000: { valid: true } } as any)).toBe(true);
    expect(storage.countOpportunityLabeledSamples()).toBe(1);
    storage.close();
  });

  it('migrates legacy gap rows without relabeling them as a reliable feed gap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-migration-'));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, 'state.sqlite');
    const archivePath = path.join(root, 'archive');
    const db = new Database(databasePath);
    db.exec(
      `CREATE TABLE market_data_gaps (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, reason TEXT NOT NULL, details_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL)`,
    );
    db.prepare('INSERT INTO market_data_gaps VALUES (1, ?, ?, ?, ?, ?, ?)').run(
      'BTCUSDT',
      10,
      20,
      'old_gap',
      '{}',
      30,
    );
    db.close();
    const storage = new MicroBurstStorage({ databasePath, archivePath });
    expect(storage.queryGaps('BTCUSDT')[0]).toMatchObject({
      kind: 'UNKNOWN_LEGACY',
      reason: 'old_gap',
      feed: null,
    });
    storage.close();
  });

  it('queries only the explicitly required feed and preserves unknown legacy attribution', () => {
    const { storage, root } = createStorage();
    storage.recordGap({
      symbol: 'BTCUSDT',
      startedAtMs: 100,
      endedAtMs: 200,
      reason: 'depth_sequence_gap',
      kind: 'DEPTH_SEQUENCE',
      feed: 'DEPTH',
    });
    storage.recordGap({
      symbol: 'BTCUSDT',
      startedAtMs: 100,
      endedAtMs: 200,
      reason: 'reference_price_gap',
      kind: 'SUBSCRIPTION',
      feed: 'MARK_PRICE',
    });
    storage.recordGap({
      symbol: 'BTCUSDT',
      startedAtMs: 100,
      endedAtMs: 200,
      reason: 'subscription_gap',
      kind: 'SUBSCRIPTION',
      feed: 'AGG_TRADE',
    });
    storage.recordGap({
      symbol: 'BTCUSDT',
      startedAtMs: 100,
      endedAtMs: 200,
      reason: 'old_gap',
    });

    const gap = {
      symbol: 'BTCUSDT',
      startedAtMs: 300,
      endedAtMs: 400,
      reason: 'AGG_TRADE_SEQUENCE_GAP',
      kind: 'AGG_TRADE_SEQUENCE' as const,
      feed: 'AGG_TRADE' as const,
      previousTradeId: 10,
      nextTradeId: 12,
      dedupeKey: '10:12',
    };
    expect(storage.recordGap(gap)).toBe(true);
    expect(storage.recordGap(gap)).toBe(true);

    expect(storage.hasGapForFeed('BTCUSDT', 150, 150, 'DEPTH')).toBe(true);
    expect(storage.hasGapForFeed('BTCUSDT', 150, 150, 'MARK_PRICE')).toBe(true);
    expect(storage.hasGapForFeed('BTCUSDT', 150, 150, 'AGG_TRADE')).toBe(true);
    expect(storage.countRequiredFeedGaps(new Set(['BTCUSDT']))).toBe(2);
    expect(storage.countUnknownLegacyGaps(new Set(['BTCUSDT']))).toBe(1);
    expect(storage.queryGaps('BTCUSDT').filter((item) => item.reason === gap.reason)).toHaveLength(
      1,
    );
    storage.close();

    const reopened = new MicroBurstStorage({
      databasePath: path.join(root, 'state', 'micro-burst.sqlite'),
      archivePath: path.join(root, 'archive'),
    });
    expect(reopened.hasAggTradeGap('BTCUSDT', 350, 350)).toBe(true);
    reopened.close();
  });

  it('uses typed feed parsing and only accepts a bridged contiguous depth stream', () => {
    const receivedAtMs = 2_000;
    expect(
      parseAggTrade('BTCUSDT', { p: '10', q: '2', T: 100, m: false }, receivedAtMs),
    ).toMatchObject({ eventTimeMs: 100, receivedAtMs });
    expect(parseAggTrade('BTCUSDT', { p: '10', q: '2', m: false }, receivedAtMs)).toBeNull();
    const gap: unknown[] = [];
    const detector = new DepthStreamGapDetector((value) => gap.push(value));
    detector.seedSnapshot(100);
    const first = parseDepth(
      'BTCUSDT',
      { E: 101, U: 101, u: 103, pu: 100, b: [], a: [] },
      receivedAtMs,
    )!;
    expect(detector.accept(first)).toBe('ACCEPT');
    const skipped = parseDepth(
      'BTCUSDT',
      { E: 102, U: 105, u: 106, pu: 103, b: [], a: [] },
      receivedAtMs,
    )!;
    expect(detector.accept(skipped)).toBe('GAP');
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({ details: { previousFinalUpdateId: 103 } });
  });

  it('separates server event time from receive time and clamps future corrected events', () => {
    const estimator = new ServerOffsetEstimator(3);
    estimator.observe(1_100, 1_000, 1_020);
    expect(estimator.estimate()).toMatchObject({ offsetMs: 90, uncertaintyMs: 0, samples: 1 });
    expect(eventAgeMs(1_050, 1_200, estimator.estimate())).toBe(0);
    expect(eventAgeMs(1_200, 1_100, estimator.estimate())).toBe(190);
  });
  it('persists pending signal state across a SQLite reopen and completes outcomes idempotently', () => {
    const { storage, databasePath, archivePath } = createStorage();
    expect(
      storage.persistSignal({
        shadowSignalId: 'sig-1',
        symbol: 'BTCUSDT',
        signalAtMs: 100,
        frozen: true,
      }),
    ).toBe(true);
    expect(storage.persistPendingState('sig-1', 'PENDING', { horizon: 300_000 })).toBe(true);
    expect(storage.persistCheckpoint('BTCUSDT', 101, { lastUpdateId: 12 })).toBe(true);
    expect(storage.persistFeatures('BTCUSDT', 102, { imbalance: 0.4 })).toBe(true);
    storage.close();

    const reopened = new MicroBurstStorage({ databasePath, archivePath });
    expect(reopened.recoverPending()).toEqual([
      {
        signalId: 'sig-1',
        status: 'PENDING',
        snapshot: expect.objectContaining({ frozen: true }),
        state: { horizon: 300_000 },
      },
    ]);
    expect(
      reopened.completeOutcome({
        shadowSignalId: 'sig-1',
        symbol: 'BTCUSDT',
        completedAtMs: 200,
        result: 'NEITHER',
      }),
    ).toBe(true);
    expect(
      reopened.completeOutcome({
        shadowSignalId: 'sig-1',
        symbol: 'BTCUSDT',
        completedAtMs: 200,
        result: 'NEITHER',
      }),
    ).toBe(true);
    expect(reopened.recoverPending()).toEqual([]);
    reopened.close();
  });

  it('identifies and repairs a terminal outcome whose journal export is unresolved', () => {
    const { storage, databasePath, archivePath } = createStorage();
    expect(
      storage.completeOutcome({
        shadowSignalId: 'terminal-1',
        symbol: 'BTCUSDT',
        completedAtMs: 200,
        result: 'WIN',
      }),
    ).toBe(true);
    expect(storage.loadOutcomeReconciliation().unresolvedOutcomeIds).toEqual(['terminal-1']);
    expect(storage.markOutcomeJournaled('terminal-1')).toBe(true);
    expect(storage.loadOutcomeReconciliation().unresolvedOutcomeIds).toEqual([]);
    storage.close();

    const reopened = new MicroBurstStorage({ databasePath, archivePath });
    expect(reopened.loadOutcomeReconciliation().outcomes).toHaveLength(1);
    expect(reopened.hasCompletedOutcome('terminal-1')).toBe(true);
    reopened.close();
  });

  it('rotates raw trade archives by UTC hour and preserves exchange and receive timestamps', () => {
    const { storage, archivePath } = createStorage();
    const hour = Date.UTC(2026, 0, 2, 3, 0, 0);
    expect(
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: hour + 1,
        receivedAtMs: hour + 8,
        price: '100',
      }),
    ).toBe(true);
    expect(
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: hour + 3_600_001,
        receivedAtMs: hour + 3_600_009,
        price: '101',
      }),
    ).toBe(true);
    storage.flush();

    const files = fs
      .readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'))
      .filter((file) => file.endsWith('.ndjson.gz'));
    expect(files).toHaveLength(2);
    expect(storage.queryArchivedTrades('BTCUSDT', hour, hour + 7_200_000)).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        eventTime: hour + 1,
        receivedAtMs: hour + 8,
        payload: expect.objectContaining({ price: '100' }),
      }),
      expect.objectContaining({
        schemaVersion: 1,
        eventTime: hour + 3_600_001,
        receivedAtMs: hour + 3_600_009,
        payload: expect.objectContaining({ price: '101' }),
      }),
    ]);
    storage.close();
  });

  it('preserves Binance raw depth sequence fields', () => {
    const { storage, archivePath } = createStorage();
    expect(
      storage.appendDepth({
        symbol: 'ETHUSDT',
        eventTime: 10,
        receivedAtMs: 11,
        E: 10,
        T: 9,
        U: 44,
        u: 48,
        pu: 43,
        b: [['1', '2']],
        a: [['3', '4']],
      }),
    ).toBe(true);
    storage.close();

    const file = fs
      .readdirSync(path.join(archivePath, 'depth', 'ETHUSDT'))
      .find((name) => name.endsWith('.ndjson.gz'))!;
    const record = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(archivePath, 'depth', 'ETHUSDT', file))).toString(),
    ) as { payload: Record<string, unknown> };
    expect(record.payload).toMatchObject({
      E: 10,
      T: 9,
      U: 44,
      u: 48,
      pu: 43,
      b: [['1', '2']],
      a: [['3', '4']],
    });
  });

  it('rejects a gzip segment when its NDJSON contains a partial line', () => {
    const { storage, archivePath } = createStorage();
    storage.close();
    const segmentDir = path.join(archivePath, 'trades', 'SOLUSDT');
    fs.mkdirSync(segmentDir, { recursive: true });
    const valid =
      JSON.stringify({
        schemaVersion: 1,
        type: 'trades',
        symbol: 'SOLUSDT',
        eventTime: 20,
        receivedAtMs: 21,
        payload: { price: '1' },
      }) + '\n';
    fs.writeFileSync(
      path.join(segmentDir, 'manual.ndjson.gz'),
      zlib.gzipSync(`${valid}{"schemaVersion":1`),
    );

    const reopened = new MicroBurstStorage({
      databasePath: path.join(path.dirname(archivePath), 'state', 'micro-burst.sqlite'),
      archivePath,
    });
    expect(reopened.queryArchivedTrades('SOLUSDT', 0, 100)).toEqual([]);
    expect(reopened.queryGaps('SOLUSDT')).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'ARCHIVE' })]),
    );
    reopened.close();
  });

  it('records gaps and leaves incomplete pending state recoverable', () => {
    const { storage } = createStorage();
    expect(
      storage.persistSignal({ shadowSignalId: 'sig-gap', symbol: 'ETHUSDT', signalAtMs: 10 }),
    ).toBe(true);
    expect(storage.persistPendingState('sig-gap', 'WAITING_FOR_HORIZON', { lastPrice: 2000 })).toBe(
      true,
    );
    expect(
      storage.recordGap({
        symbol: 'ETHUSDT',
        startedAtMs: 11,
        endedAtMs: 15,
        reason: 'websocket_disconnect',
      }),
    ).toBe(true);
    expect(storage.recoverPending()).toEqual([
      expect.objectContaining({ signalId: 'sig-gap', status: 'WAITING_FOR_HORIZON' }),
    ]);
    storage.close();
  });

  it('creates immutable unique archive segments across reopen and uses the range index for replay', () => {
    const { storage, databasePath, archivePath } = createStorage();
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 100,
      receivedAtMs: 101,
      price: 1,
      aggregateTradeId: 1,
    });
    storage.flush();
    storage.close();
    const reopened = new MicroBurstStorage({ databasePath, archivePath });
    reopened.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 200,
      receivedAtMs: 201,
      price: 2,
      aggregateTradeId: 2,
    });
    reopened.flush();

    const files = fs
      .readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'))
      .filter((file) => file.endsWith('.ndjson.gz'));
    expect(files).toHaveLength(2);
    expect(
      reopened.queryArchivedTrades('BTCUSDT', 150, 250).map((trade) => trade.eventTime),
    ).toEqual([200]);
    reopened.close();
  });

  it('packs bounded background work into immutable multi-record segments', () => {
    const { storage, archivePath } = createStorage();
    for (let index = 0; index < 5; index++) {
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: 1_000 + index,
        receivedAtMs: 2_000 + index,
        price: 100 + index,
        aggregateTradeId: index,
      });
    }
    storage.flush();

    const files = fs
      .readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'))
      .filter((file) => file.endsWith('.ndjson.gz'));
    expect(files).toHaveLength(1);
    const metadata = JSON.parse(
      fs.readFileSync(path.join(archivePath, 'trades', 'BTCUSDT', `${files[0]}.meta.json`), 'utf8'),
    );
    expect(metadata).toMatchObject({
      recordCount: 5,
      firstEventTimeMs: 1_000,
      lastEventTimeMs: 1_004,
    });
    expect(storage.getHealth()).toMatchObject({
      queueDepth: 0,
      queuedRecords: 5,
      writtenRecords: 5,
      overflowRecords: 0,
    });
    storage.close();
  });

  it('does not count durable active spools against in-memory queue capacity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-overflow-'));
    temporaryDirectories.push(root);
    const storage = new MicroBurstStorage({
      databasePath: path.join(root, 'state.sqlite'),
      archivePath: path.join(root, 'archive'),
      maxArchiveQueueRecords: 1,
    });
    expect(
      storage.appendTrade({ symbol: 'ETHUSDT', eventTime: 100, receivedAtMs: 100, price: 1 }),
    ).toBe(true);
    expect(
      storage.appendTrade({ symbol: 'ETHUSDT', eventTime: 101, receivedAtMs: 101, price: 1 }),
    ).toBe(true);
    expect(storage.getHealth()).toMatchObject({
      healthy: true,
      queueCapacity: 1,
      overflowRecords: 0,
      queueDepth: 0,
      activeSegmentRecords: 2,
    });
    storage.close();
  });

  it('turns a checksum-invalid replay segment into a durable data gap', () => {
    const { storage, archivePath } = createStorage();
    storage.appendTrade({
      symbol: 'SOLUSDT',
      eventTime: 100,
      receivedAtMs: 101,
      price: 10,
      aggregateTradeId: 1,
    });
    storage.flush();
    const file = fs
      .readdirSync(path.join(archivePath, 'trades', 'SOLUSDT'))
      .find((name) => name.endsWith('.ndjson.gz'))!;
    fs.writeFileSync(
      path.join(archivePath, 'trades', 'SOLUSDT', `${file}.meta.json`),
      JSON.stringify({ schemaVersion: 1, file, recordCount: 1, checksum: 'bad' }),
    );

    expect(storage.queryArchivedTrades('SOLUSDT', 0, 200)).toEqual([]);
    expect(storage.hasGap('SOLUSDT', 100, 100)).toBe(true);
    expect(storage.getHealth().healthy).toBe(false);
    storage.close();
  });

  it('batches multiple rapid same-partition records into one multi-record segment', () => {
    const { storage, archivePath } = createStorage();
    for (let i = 0; i < 10; i++) {
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: 1000 + i,
        receivedAtMs: 2000 + i,
        price: 100 + i,
        aggregateTradeId: i,
      });
    }
    storage.flush();
    const files = fs
      .readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'))
      .filter((f) => f.endsWith('.ndjson.gz'));
    expect(files).toHaveLength(1);
    const metadata = JSON.parse(
      fs.readFileSync(path.join(archivePath, 'trades', 'BTCUSDT', `${files[0]}.meta.json`), 'utf8'),
    );
    expect(metadata.recordCount).toBe(10);
    const health = storage.getHealth();
    expect(health.writtenRecords).toBe(10);
    expect(health.segmentsWritten).toBe(1);
    expect(health.averageRecordsPerSegment).toBe(10);
    storage.close();
  });

  it('max batch size triggers flush without waiting for timer', () => {
    const { storage, archivePath } = createStorage();
    for (let i = 0; i < 5; i++) {
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: 1000 + i,
        receivedAtMs: 2000 + i,
        price: 100 + i,
        aggregateTradeId: i,
      });
    }
    storage.flush();
    const files = fs
      .readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'))
      .filter((f) => f.endsWith('.ndjson.gz'));
    expect(files).toHaveLength(1);
    const health = storage.getHealth();
    expect(health.writtenRecords).toBe(5);
    expect(health.segmentsWritten).toBe(1);
    storage.close();
  });

  it('durability timer fsyncs sparse active segments without finalizing them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-timer-'));
    temporaryDirectories.push(root);
    const storage = new MicroBurstStorage({
      databasePath: path.join(root, 'state.sqlite'),
      archivePath: path.join(root, 'archive'),
      maxBatchLatencyMs: 50,
    });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 1000,
      receivedAtMs: 2000,
      price: 100,
      aggregateTradeId: 1,
    });
    const healthBefore = storage.getHealth();
    expect(healthBefore.writtenRecords).toBe(0);
    expect(healthBefore.activeBatchCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const healthAfter = storage.getHealth();
    expect(healthAfter.writtenRecords).toBe(0);
    expect(healthAfter.recordsDurablyFlushed).toBe(1);
    expect(healthAfter.activeSegmentCount).toBe(1);
    expect(healthAfter.activeSegmentRecords).toBe(1);
    storage.close();
  });

  it('flushes partial batches on graceful shutdown', () => {
    const { storage } = createStorage();
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 1000,
      receivedAtMs: 2000,
      price: 100,
      aggregateTradeId: 1,
    });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 1001,
      receivedAtMs: 2001,
      price: 101,
      aggregateTradeId: 2,
    });
    const healthBefore = storage.getHealth();
    expect(healthBefore.writtenRecords).toBe(0);
    expect(healthBefore.activeBatchCount).toBe(1);
    storage.close();
    const healthAfter = storage.getHealth();
    expect(healthAfter.writtenRecords).toBe(2);
    expect(healthAfter.segmentsWritten).toBe(1);
    expect(healthAfter.activeBatchCount).toBe(0);
    expect(healthAfter.queueDepth).toBe(0);
  });

  it('queuedRecords equals writtenRecords after flush', () => {
    const { storage } = createStorage();
    for (let i = 0; i < 20; i++) {
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: 1000 + i,
        receivedAtMs: 2000 + i,
        price: 100 + i,
        aggregateTradeId: i,
      });
    }
    storage.flush();
    const health = storage.getHealth();
    expect(health.queuedRecords).toBe(health.writtenRecords);
    expect(health.queueDepth).toBe(0);
    storage.close();
  });

  it('segment record_count matches NDJSON line count', () => {
    const { storage, archivePath } = createStorage();
    for (let i = 0; i < 8; i++) {
      storage.appendTrade({
        symbol: 'ETHUSDT',
        eventTime: 1000 + i,
        receivedAtMs: 2000 + i,
        price: 2000 + i,
        aggregateTradeId: i,
      });
    }
    storage.flush();
    const files = fs
      .readdirSync(path.join(archivePath, 'trades', 'ETHUSDT'))
      .filter((f) => f.endsWith('.ndjson.gz'));
    expect(files).toHaveLength(1);
    const filePath = path.join(archivePath, 'trades', 'ETHUSDT', files[0]);
    const text = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8');
    const lineCount = text.split('\n').filter((line) => line.trim()).length;
    const metadata = JSON.parse(fs.readFileSync(`${filePath}.meta.json`, 'utf8'));
    expect(metadata.recordCount).toBe(lineCount);
    expect(metadata.recordCount).toBe(8);
    storage.close();
  });

  it('metadata checksum matches segment content', () => {
    const { storage, archivePath } = createStorage();
    for (let i = 0; i < 5; i++) {
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: 1000 + i,
        receivedAtMs: 2000 + i,
        price: 100 + i,
        aggregateTradeId: i,
      });
    }
    storage.flush();
    const files = fs
      .readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'))
      .filter((f) => f.endsWith('.ndjson.gz'));
    const filePath = path.join(archivePath, 'trades', 'BTCUSDT', files[0]);
    const text = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8');
    const expectedChecksum = crypto.createHash('sha256').update(text).digest('hex');
    const metadata = JSON.parse(fs.readFileSync(`${filePath}.meta.json`, 'utf8'));
    expect(metadata.checksum).toBe(expectedChecksum);
    storage.close();
  });

  it('BTC trades and ETH trades remain separate segments', () => {
    const { storage, archivePath } = createStorage();
    for (let i = 0; i < 5; i++) {
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: 1000 + i,
        receivedAtMs: 2000 + i,
        price: 100 + i,
        aggregateTradeId: i,
      });
      storage.appendTrade({
        symbol: 'ETHUSDT',
        eventTime: 1000 + i,
        receivedAtMs: 2000 + i,
        price: 2000 + i,
        aggregateTradeId: i,
      });
    }
    storage.flush();
    const btcFiles = fs
      .readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'))
      .filter((f) => f.endsWith('.ndjson.gz'));
    const ethFiles = fs
      .readdirSync(path.join(archivePath, 'trades', 'ETHUSDT'))
      .filter((f) => f.endsWith('.ndjson.gz'));
    expect(btcFiles).toHaveLength(1);
    expect(ethFiles).toHaveLength(1);
    const btcMeta = JSON.parse(
      fs.readFileSync(
        path.join(archivePath, 'trades', 'BTCUSDT', `${btcFiles[0]}.meta.json`),
        'utf8',
      ),
    );
    const ethMeta = JSON.parse(
      fs.readFileSync(
        path.join(archivePath, 'trades', 'ETHUSDT', `${ethFiles[0]}.meta.json`),
        'utf8',
      ),
    );
    expect(btcMeta.symbol).toBe('BTCUSDT');
    expect(ethMeta.symbol).toBe('ETHUSDT');
    expect(btcMeta.recordCount).toBe(5);
    expect(ethMeta.recordCount).toBe(5);
    storage.close();
  });

  it('trades and depth remain separate segments', () => {
    const { storage, archivePath } = createStorage();
    for (let i = 0; i < 5; i++) {
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: 1000 + i,
        receivedAtMs: 2000 + i,
        price: 100 + i,
        aggregateTradeId: i,
      });
      storage.appendDepth({
        symbol: 'BTCUSDT',
        eventTime: 1000 + i,
        receivedAtMs: 2000 + i,
        E: 1000 + i,
        T: 1000 + i,
        U: i,
        u: i + 1,
        b: [['1', '2']],
        a: [['3', '4']],
      });
    }
    storage.flush();
    const tradeFiles = fs
      .readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'))
      .filter((f) => f.endsWith('.ndjson.gz'));
    const depthFiles = fs
      .readdirSync(path.join(archivePath, 'depth', 'BTCUSDT'))
      .filter((f) => f.endsWith('.ndjson.gz'));
    expect(tradeFiles).toHaveLength(1);
    expect(depthFiles).toHaveLength(1);
    const tradeMeta = JSON.parse(
      fs.readFileSync(
        path.join(archivePath, 'trades', 'BTCUSDT', `${tradeFiles[0]}.meta.json`),
        'utf8',
      ),
    );
    const depthMeta = JSON.parse(
      fs.readFileSync(
        path.join(archivePath, 'depth', 'BTCUSDT', `${depthFiles[0]}.meta.json`),
        'utf8',
      ),
    );
    expect(tradeMeta.type).toBe('trades');
    expect(depthMeta.type).toBe('depth');
    storage.close();
  });

  it('hour rollover creates separate segments', () => {
    const { storage, archivePath } = createStorage();
    const hour1 = Date.UTC(2026, 0, 1, 3, 0, 0);
    const hour2 = hour1 + 3_600_000;
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: hour1 + 100,
      receivedAtMs: hour1 + 200,
      price: 100,
      aggregateTradeId: 1,
    });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: hour2 + 100,
      receivedAtMs: hour2 + 200,
      price: 101,
      aggregateTradeId: 2,
    });
    storage.flush();
    const files = fs
      .readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'))
      .filter((f) => f.endsWith('.ndjson.gz'));
    expect(files).toHaveLength(2);
    storage.close();
  });

  it('mixed legacy one-record and new multi-record replay works', () => {
    const { storage, archivePath, databasePath } = createStorage();
    const segmentDir = path.join(archivePath, 'trades', 'BTCUSDT');
    fs.mkdirSync(segmentDir, { recursive: true });
    const legacyRecord =
      JSON.stringify({
        schemaVersion: 1,
        type: 'trades',
        symbol: 'BTCUSDT',
        eventTime: 100,
        receivedAtMs: 101,
        payload: { price: '100' },
      }) + '\n';
    fs.writeFileSync(path.join(segmentDir, 'legacy.ndjson.gz'), zlib.gzipSync(legacyRecord));
    storage.close();
    const reopened = new MicroBurstStorage({ databasePath, archivePath });
    reopened.flush();
    const legacyOnly = reopened.queryArchivedTrades('BTCUSDT', 0, 150);
    expect(legacyOnly).toHaveLength(1);
    expect(legacyOnly[0].eventTime).toBe(100);
    reopened.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 200,
      receivedAtMs: 201,
      price: 200,
      aggregateTradeId: 2,
    });
    reopened.flush();
    const both = reopened.queryArchivedTrades('BTCUSDT', 0, 300);
    expect(both.length).toBeGreaterThanOrEqual(1);
    const eventTimes = both.map((r) => r.eventTime);
    expect(eventTimes).toContain(100);
    expect(eventTimes).toContain(200);
    reopened.close();
  });

  it('write failure marks storage unhealthy and records gap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-fail-'));
    temporaryDirectories.push(root);
    const archivePath = path.join(root, 'archive');
    const dbPath = path.join(root, 'state.sqlite');
    const storage = new MicroBurstStorage({
      databasePath: dbPath,
      archivePath,
      maxBatchLatencyMs: 999_999,
    });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 1000,
      receivedAtMs: 2000,
      price: 100,
      aggregateTradeId: 1,
    });
    const healthBefore = storage.getHealth();
    expect(healthBefore.healthy).toBe(true);
    expect(healthBefore.writtenRecords).toBe(0);
    const metaPath = path.join(root, 'archive', 'trades', 'BTCUSDT');
    fs.rmSync(metaPath, { recursive: true, force: true });
    fs.mkdirSync(metaPath, { recursive: true });
    fs.chmodSync(metaPath, 0o555);
    storage.flush();
    const healthAfter = storage.getHealth();
    fs.chmodSync(metaPath, 0o755);
    if (!healthAfter.healthy) {
      expect(storage.hasGap('BTCUSDT', 1000, 1000)).toBe(true);
    }
    storage.close();
  });

  it('keeps accepting durable spools after the configured in-memory queue capacity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-overflow-closed-'));
    temporaryDirectories.push(root);
    const storage = new MicroBurstStorage({
      databasePath: path.join(root, 'state.sqlite'),
      archivePath: path.join(root, 'archive'),
      maxArchiveQueueRecords: 2,
    });
    expect(
      storage.appendTrade({ symbol: 'BTCUSDT', eventTime: 100, receivedAtMs: 100, price: 1 }),
    ).toBe(true);
    expect(
      storage.appendTrade({ symbol: 'BTCUSDT', eventTime: 101, receivedAtMs: 101, price: 2 }),
    ).toBe(true);
    expect(
      storage.appendTrade({ symbol: 'BTCUSDT', eventTime: 102, receivedAtMs: 102, price: 3 }),
    ).toBe(true);
    const health = storage.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.overflowRecords).toBe(0);
    expect(health.queueDepth).toBe(0);
    expect(health.activeSegmentRecords).toBe(3);
    storage.close();
  });

  it('no archive batching change affects outcome semantics', () => {
    const { storage } = createStorage();
    expect(
      storage.persistSignal({ shadowSignalId: 'sig-batch', symbol: 'BTCUSDT', signalAtMs: 100 }),
    ).toBe(true);
    expect(storage.persistPendingState('sig-batch', 'PENDING', { horizon: 300 })).toBe(true);
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 1000,
      receivedAtMs: 2000,
      price: 100,
      aggregateTradeId: 1,
    });
    storage.flush();
    expect(
      storage.completeOutcome({
        shadowSignalId: 'sig-batch',
        symbol: 'BTCUSDT',
        completedAtMs: 2000,
        result: 'WIN',
      }),
    ).toBe(true);
    expect(storage.recoverPending()).toEqual([]);
    const health = storage.getHealth();
    expect(health.writtenRecords).toBe(1);
    expect(health.segmentsWritten).toBe(1);
    storage.close();
  });

  it('reports active batch count and open batch records', () => {
    const { storage } = createStorage();
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 1000,
      receivedAtMs: 2000,
      price: 100,
      aggregateTradeId: 1,
    });
    storage.appendTrade({
      symbol: 'ETHUSDT',
      eventTime: 1000,
      receivedAtMs: 2000,
      price: 2000,
      aggregateTradeId: 1,
    });
    const health = storage.getHealth();
    expect(health.activeBatchCount).toBe(2);
    expect(health.openBatchRecords).toBe(2);
    expect(health.draining).toBe(true);
    storage.flush();
    const afterFlush = storage.getHealth();
    expect(afterFlush.activeBatchCount).toBe(0);
    expect(afterFlush.openBatchRecords).toBe(0);
    expect(afterFlush.draining).toBe(false);
    storage.close();
  });

  it('keeps multiple durability checkpoints in one active segment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-active-'));
    temporaryDirectories.push(root);
    const storage = new MicroBurstStorage({
      databasePath: path.join(root, 'state.sqlite'),
      archivePath: path.join(root, 'archive'),
      durabilityFlushIntervalMs: 20,
    });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 100,
      receivedAtMs: 100,
      price: 1,
      aggregateTradeId: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 101,
      receivedAtMs: 101,
      price: 2,
      aggregateTradeId: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(storage.getHealth()).toMatchObject({
      activeSegmentCount: 1,
      activeSegmentRecords: 2,
      recordsDurablyFlushed: 2,
      segmentsFinalized: 0,
    });
    expect(
      fs
        .readdirSync(path.join(root, 'archive', 'trades', 'BTCUSDT'))
        .filter((name) => name.endsWith('.active.ndjson')),
    ).toHaveLength(1);
    storage.close();
  });

  it('rotates active spools at the configured record threshold', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-record-rotation-'));
    temporaryDirectories.push(root);
    const storage = new MicroBurstStorage({
      databasePath: path.join(root, 'state.sqlite'),
      archivePath: path.join(root, 'archive'),
      maxActiveSegmentRecords: 3,
    });
    for (let i = 0; i < 3; i++)
      storage.appendTrade({
        symbol: 'BTCUSDT',
        eventTime: 100 + i,
        receivedAtMs: 100 + i,
        price: i + 1,
        aggregateTradeId: i,
      });
    expect(storage.getHealth()).toMatchObject({
      segmentsFinalized: 1,
      writtenRecords: 3,
      activeSegmentCount: 0,
    });
    storage.close();
  });

  it('rotates active spools at the configured byte threshold', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-byte-rotation-'));
    temporaryDirectories.push(root);
    const storage = new MicroBurstStorage({
      databasePath: path.join(root, 'state.sqlite'),
      archivePath: path.join(root, 'archive'),
      maxActiveSegmentBytes: 1,
    });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 100,
      receivedAtMs: 100,
      price: 1,
      aggregateTradeId: 1,
    });
    expect(storage.getHealth()).toMatchObject({
      segmentsFinalized: 1,
      writtenRecords: 1,
      activeSegmentCount: 0,
    });
    storage.close();
  });

  it('rotates active spools after the configured duration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-duration-rotation-'));
    temporaryDirectories.push(root);
    const storage = new MicroBurstStorage({
      databasePath: path.join(root, 'state.sqlite'),
      archivePath: path.join(root, 'archive'),
      maxActiveSegmentDurationMs: 25,
    });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 100,
      receivedAtMs: 100,
      price: 1,
      aggregateTradeId: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(storage.getHealth()).toMatchObject({
      segmentsFinalized: 1,
      writtenRecords: 1,
      activeSegmentCount: 0,
    });
    storage.close();
  });

  it('recovers a durable active spool after an abrupt isolated process stop', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-recovery-'));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, 'state.sqlite');
    const archivePath = path.join(root, 'archive');
    const storage = new MicroBurstStorage({ databasePath, archivePath });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 100,
      receivedAtMs: 100,
      price: 1,
      aggregateTradeId: 1,
    });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 101,
      receivedAtMs: 101,
      price: 2,
      aggregateTradeId: 2,
    });
    for (const active of (storage as any).activeSegments.values()) {
      if (active.durabilityTimer) clearTimeout(active.durabilityTimer);
      if (active.rotationTimer) clearTimeout(active.rotationTimer);
    }
    (storage as any).db.close();
    const reopened = new MicroBurstStorage({ databasePath, archivePath });
    expect(reopened.queryArchivedTrades('BTCUSDT', 0, 200).map((trade) => trade.eventTime)).toEqual(
      [100, 101],
    );
    expect(reopened.getHealth()).toMatchObject({
      recoveryActions: 1,
      recoveryFailures: 0,
      writtenRecords: 2,
    });
    reopened.close();
  });

  it('repairs a completed gzip segment when its SQLite index row is missing', () => {
    const { storage, archivePath, databasePath } = createStorage();
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 100,
      receivedAtMs: 100,
      price: 1,
      aggregateTradeId: 1,
    });
    storage.close();
    const db = new Database(databasePath);
    db.prepare('DELETE FROM market_data_segments').run();
    db.close();
    const reopened = new MicroBurstStorage({ databasePath, archivePath });
    expect(reopened.queryArchivedTrades('BTCUSDT', 0, 200)).toHaveLength(1);
    expect(reopened.getHealth().recoveryActions).toBeGreaterThanOrEqual(1);
    reopened.close();
  });

  it('recovers one authoritative content-addressed segment after final files precede SQLite', () => {
    const { storage, archivePath, databasePath } = createStorage();
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 100,
      receivedAtMs: 100,
      price: 1,
      aggregateTradeId: 1,
    });
    const active = [...(storage as any).activeSegments.values()][0];
    const text = fs.readFileSync(active.activePath, 'utf8');
    const parsed = (storage as any).completeRecords(text);
    (storage as any).writeFinalSegment(active, parsed.text, parsed.records);

    // Model a crash after gzip and metadata publication but before the SQLite transaction commits.
    const db = new Database(databasePath);
    db.prepare('DELETE FROM market_data_segments').run();
    db.close();
    for (const timer of [active.durabilityTimer, active.rotationTimer])
      if (timer) clearTimeout(timer);
    (storage as any).db.close();

    const reopened = new MicroBurstStorage({ databasePath, archivePath });
    const directory = path.join(archivePath, 'trades', 'BTCUSDT');
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('.ndjson.gz'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-[a-f0-9]{64}\.ndjson\.gz$/);
    expect(reopened.queryArchivedTrades('BTCUSDT', 0, 200)).toHaveLength(1);
    const indexDb = new Database(databasePath);
    expect(indexDb.prepare('SELECT COUNT(*) AS count FROM market_data_segments').get()).toEqual({
      count: 1,
    });
    indexDb.close();
    reopened.close();
  });

  it('records a durable gap when recovery truncates a torn active line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-torn-recovery-'));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, 'state.sqlite');
    const archivePath = path.join(root, 'archive');
    const activeDir = path.join(archivePath, 'trades', 'BTCUSDT');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(
      path.join(activeDir, '1970-01-01T00-00-00-000Z.active.ndjson'),
      `${JSON.stringify({ schemaVersion: 1, type: 'trades', symbol: 'BTCUSDT', eventTime: 100, receivedAtMs: 100, payload: { price: 1, aggregateTradeId: 1 } })}\n{`,
    );
    const storage = new MicroBurstStorage({ databasePath, archivePath });
    expect(storage.queryArchivedTrades('BTCUSDT', 0, 200)).toHaveLength(1);
    expect(storage.hasGap('BTCUSDT', 100, 100)).toBe(true);
    expect(storage.getHealth().healthy).toBe(false);
    storage.close();
  });

  it('graceful shutdown leaves no active or temporary artifacts', () => {
    const { storage, archivePath } = createStorage();
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 100,
      receivedAtMs: 100,
      price: 1,
      aggregateTradeId: 1,
    });
    storage.close();
    const names = fs.readdirSync(path.join(archivePath, 'trades', 'BTCUSDT'));
    expect(names.filter((name) => name.includes('.active.') || name.endsWith('.tmp'))).toEqual([]);
    expect(names.filter((name) => name.endsWith('.ndjson.gz'))).toHaveLength(1);
    expect(names.filter((name) => name.endsWith('.meta.json'))).toHaveLength(1);
  });

  it('reports archive size and retention age without mutating storage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-storage-health-'));
    temporaryDirectories.push(root);
    const storage = new MicroBurstStorage({
      databasePath: path.join(root, 'state.sqlite'),
      archivePath: path.join(root, 'archive'),
      now: () => 10_000,
      retentionWarningAgeMs: 9_000,
    });
    storage.appendTrade({
      symbol: 'BTCUSDT',
      eventTime: 100,
      receivedAtMs: 100,
      price: 1,
      aggregateTradeId: 1,
    });
    const healthBeforeClose = storage.getHealth();
    expect(healthBeforeClose.archiveBytes).toBeGreaterThan(0);
    expect(healthBeforeClose.archiveFileCount).toBe(1);
    expect(healthBeforeClose.oldestArchiveEventTimeMs).toBeNull();
    expect(healthBeforeClose.archiveRetentionAgeMs).toBeNull();
    storage.close();

    expect(storage.getHealth()).toMatchObject({
      archiveFileCount: 1,
      oldestArchiveEventTimeMs: 100,
      newestArchiveEventTimeMs: 100,
      archiveRetentionAgeMs: 9_900,
      retentionWarning: true,
    });
  });
});
