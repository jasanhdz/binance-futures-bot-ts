import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MarketSnapshotV1 } from '../../core/market-data/MarketSnapshotProvider';
import { JsonlMarketSnapshotSink } from './JsonlMarketSnapshotSink';

function snapshot(snapshotId: string, capturedAtMs: number): MarketSnapshotV1 {
  return {
    schemaVersion: 1,
    snapshotId,
    symbol: 'ETHUSDT',
    captureStartedAtMs: capturedAtMs - 1,
    capturedAtMs,
    primary: { quote: { value: { midPrice: 100 } } } as unknown as MarketSnapshotV1['primary'],
    health: 'COMPLETE',
    provenance: { request: { symbol: 'ETHUSDT', quote: true } } as MarketSnapshotV1['provenance'],
  };
}

describe('JsonlMarketSnapshotSink', () => {
  it('stores one canonical snapshot when only local capture boundaries differ', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-blackbox-'));
    try {
      const path = join(root, 'snapshots.jsonl');
      let now = 1_000;
      const sink = new JsonlMarketSnapshotSink(path, { now: () => now });

      const first = await sink.append(snapshot('snapshot-1', 900));
      now += 10;
      const second = await sink.append(snapshot('snapshot-2', 910));
      await sink.drain();

      expect(first).toMatchObject({ snapshotId: 'snapshot-1', stored: true });
      expect(second).toMatchObject({ snapshotId: 'snapshot-1', stored: false });
      const records = (await readFile(path, 'utf8')).trim().split('\n');
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0])).toMatchObject({
        schemaVersion: 2,
        schema: 'STRATEGY_MARKET_SNAPSHOT_EVIDENCE_V2',
        snapshotId: 'snapshot-1',
        marketSnapshot: { schemaVersion: 1, snapshotId: 'snapshot-1' },
      });
      expect(sink.health()).toMatchObject({ storedSnapshots: 1, deduplicatedSnapshots: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deduplicates concurrent equivalent captures atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-blackbox-concurrent-'));
    try {
      const path = join(root, 'snapshots.jsonl');
      const sink = new JsonlMarketSnapshotSink(path, { now: () => 1_000 });

      const [first, second] = await Promise.all([
        sink.append(snapshot('snapshot-a', 900)),
        sink.append(snapshot('snapshot-b', 901)),
      ]);
      await sink.drain();

      expect([first.stored, second.stored].sort()).toEqual([false, true]);
      expect(first.snapshotId).toBe(second.snapshotId);
      expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stores a new snapshot when causal market content changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-blackbox-change-'));
    try {
      const path = join(root, 'snapshots.jsonl');
      const sink = new JsonlMarketSnapshotSink(path, { now: () => 1_000 });
      const changed = {
        ...snapshot('snapshot-b', 901),
        primary: {
          ...snapshot('snapshot-b', 901).primary,
          quote: { value: { midPrice: 101 } },
        } as unknown as MarketSnapshotV1['primary'],
      };

      const [first, second] = await Promise.all([
        sink.append(snapshot('snapshot-a', 900)),
        sink.append(changed),
      ]);
      await sink.drain();

      expect(first.stored).toBe(true);
      expect(second.stored).toBe(true);
      expect(first.snapshotId).not.toBe(second.snapshotId);
      expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
