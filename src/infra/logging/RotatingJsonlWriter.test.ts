import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RotatingJsonlWriter } from './RotatingJsonlWriter';

describe('RotatingJsonlWriter', () => {
  it('serializes concurrent writes and rotates the active file without losing records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rotating-jsonl-'));
    try {
      const path = join(root, 'events.jsonl');
      const writer = new RotatingJsonlWriter(path, {
        maxBytes: 80,
        compressRotated: false,
        now: () => 1_000,
      });

      await Promise.all(
        Array.from({ length: 12 }, (_, id) => writer.append({ id, value: 'data' })),
      );
      await writer.drain();

      const files = await readdir(root);
      const records: Array<{ id: number }> = [];
      for (const file of files.filter((name) => name.endsWith('.jsonl'))) {
        const text = (await readFile(join(root, file), 'utf8')).trim();
        if (text) records.push(...text.split('\n').map((line) => JSON.parse(line)));
      }
      expect(records.map((record) => record.id).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 12 }, (_, id) => id),
      );
      expect(writer.health().rotations).toBeGreaterThan(0);
      expect(writer.health().recordsWritten).toBe(12);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects excess queued evidence instead of allowing unbounded memory growth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bounded-jsonl-'));
    try {
      const writer = new RotatingJsonlWriter(join(root, 'events.jsonl'), {
        maxPendingWrites: 1,
        compressRotated: false,
      });

      const first = writer.append({ id: 1 });
      await expect(writer.append({ id: 2 })).rejects.toThrow('JSONL_WRITER_BACKPRESSURE_LIMIT');
      await first;

      expect(writer.health()).toMatchObject({
        recordsWritten: 1,
        pendingWrites: 0,
        peakPendingWrites: 1,
        overloadRejected: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compresses rotated archives and keeps every record readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compressed-jsonl-'));
    try {
      const path = join(root, 'events.jsonl');
      const writer = new RotatingJsonlWriter(path, { maxBytes: 48 });

      await writer.append({ id: 1, payload: 'a'.repeat(32) });
      await writer.append({ id: 2, payload: 'b'.repeat(32) });
      await writer.append({ id: 3, payload: 'c'.repeat(32) });
      await writer.drain();

      const files = await readdir(root);
      const records: Array<{ id: number }> = [];
      for (const file of files) {
        const data = await readFile(join(root, file));
        const text = file.endsWith('.gz')
          ? gunzipSync(data).toString('utf8')
          : data.toString('utf8');
        records.push(
          ...text
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        );
      }

      expect(files.filter((file) => file.endsWith('.jsonl.gz'))).toHaveLength(2);
      expect(records.map((record) => record.id).sort()).toEqual([1, 2, 3]);
      expect(writer.health()).toMatchObject({ rotations: 2, compressions: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
