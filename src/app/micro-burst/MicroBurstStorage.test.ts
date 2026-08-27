import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { MicroBurstStorage } from './MicroBurstStorage';

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

  it('replays valid records when a gzip segment ends in a partial NDJSON line', () => {
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
    expect(reopened.queryArchivedTrades('SOLUSDT', 0, 100)).toEqual([
      expect.objectContaining({ eventTime: 20, receivedAtMs: 21 }),
    ]);
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
});
