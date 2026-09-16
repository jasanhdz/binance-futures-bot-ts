import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'node:perf_hooks';
import {
  readAegisClosedTradeOutcomes,
  readStrategyClosedTradeOutcomes,
} from './AegisClosedTradeHistoryReader';

describe('readAegisClosedTradeOutcomes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-closed-trades-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('loads only valid closed Live Aegis outcomes', async () => {
    const records = [
      {
        trade_id: 'legacy-loss',
        closed_at: '2026-07-27T01:00:00.000Z',
        pnl_usdt: -1,
        status: 'CLOSED',
        strategy: 'AEGIS_TURBO',
        mode: 'AEGIS_TURBO_MICRO_LIVE',
      },
      {
        trade_id: 'loss',
        closed_at: '2026-07-27T01:30:00.000Z',
        pnl_usdt: -1,
        status: 'CLOSED',
        strategy: 'AEGIS_TURBO',
        mode: 'AEGIS_TURBO_MICRO_LIVE',
        owner: 'AEGIS',
        origin: 'BOT',
        ownership_status: 'VERIFIED',
        eligible_for_bot_metrics: true,
      },
      {
        trade_id: 'manual',
        closed_at: '2026-07-27T01:45:00.000Z',
        pnl_usdt: 99,
        status: 'CLOSED',
        strategy: 'AEGIS_TURBO',
        mode: 'AEGIS_TURBO_MICRO_LIVE',
        owner: 'EXTERNAL',
        origin: 'MANUAL_EXTERNAL',
        ownership_status: 'UNKNOWN',
        eligible_for_bot_metrics: false,
      },
      {
        trade_id: 'open',
        closed_at: '2026-07-27T02:00:00.000Z',
        pnl_usdt: 2,
        status: 'OPEN',
        strategy: 'AEGIS_TURBO',
        mode: 'AEGIS_TURBO_MICRO_LIVE',
      },
      {
        trade_id: 'shadow',
        closed_at: '2026-07-27T03:00:00.000Z',
        pnl_usdt: 3,
        status: 'CLOSED',
        strategy: 'AEGIS_TURBO',
        mode: 'SHADOW',
      },
    ];
    await fs.writeFile(
      path.join(tempDir, 'turbo_trades_2026-07-27.jsonl'),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\nmalformed\n`,
    );

    await expect(readAegisClosedTradeOutcomes(tempDir)).resolves.toEqual([
      { tradeId: 'loss', closedAt: '2026-07-27T01:30:00.000Z', pnlUsdt: -1 },
    ]);
  });

  it('returns no outcomes when the history directory does not exist', async () => {
    await expect(readAegisClosedTradeOutcomes(path.join(tempDir, 'missing'))).resolves.toEqual([]);
  });

  it('loads verified exact strategy outcomes for account-wide reconstruction', async () => {
    const ownership = {
      status: 'CLOSED',
      mode: 'AEGIS_TURBO_MICRO_LIVE',
      owner: 'AEGIS',
      origin: 'BOT',
      ownership_status: 'VERIFIED',
      eligible_for_bot_metrics: true,
      closed_at: '2026-07-27T01:30:00.000Z',
      pnl_usdt: -1,
    };
    await fs.writeFile(
      path.join(tempDir, 'turbo_trades_2026-07-27.jsonl'),
      [
        { ...ownership, trade_id: 'AEGIS-TURBO-1', strategy: 'AEGIS_TURBO' },
        { ...ownership, trade_id: 'MOMENTUM-RIDE-1', strategy: 'MOMENTUM_RIDE' },
        { ...ownership, trade_id: 'MICRO-BURST-1', strategy: 'MICRO_BURST' },
        { ...ownership, trade_id: 'MICRO-BURST-V1-1', strategy: 'MICRO_BURST_V1' },
        {
          ...ownership,
          trade_id: 'MICRO-BURST-ESTIMATED',
          strategy: 'MICRO_BURST',
          metadata: { pnl_status: 'ESTIMATED_FROM_MARK_PRICE' },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
    );

    const file = path.join(tempDir, 'turbo_trades_2026-07-27.jsonl');
    const original = await fs.readFile(file, 'utf8');
    const outcomes = await readStrategyClosedTradeOutcomes(tempDir);
    expect(outcomes).toHaveLength(4);
    expect(outcomes).toContainEqual({
      tradeId: 'MICRO-BURST-V1-1',
      closedAt: ownership.closed_at,
      pnlUsdt: -1,
    });
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  it('reuses unchanged files and rereads only a journal file that changed', async () => {
    const file = path.join(tempDir, 'turbo_trades_2026-07-27.jsonl');
    const record = {
      trade_id: 'MICRO-BURST-1',
      closed_at: '2026-07-27T01:30:00.000Z',
      pnl_usdt: -1,
      status: 'CLOSED',
      strategy: 'MICRO_BURST',
      mode: 'AEGIS_TURBO_MICRO_LIVE',
      owner: 'AEGIS',
      origin: 'BOT',
      ownership_status: 'VERIFIED',
      eligible_for_bot_metrics: true,
    };
    await fs.writeFile(file, `${JSON.stringify(record)}\n`);
    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toHaveLength(1);
    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toHaveLength(1);
    await fs.appendFile(file, `${JSON.stringify({ ...record, trade_id: 'MICRO-BURST-2' })}\n`);
    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toHaveLength(2);
  });

  it('handles rotation, truncation, replacement, and an incomplete tail without stale results', async () => {
    const first = path.join(tempDir, 'turbo_trades_2026-07-27.jsonl');
    const second = path.join(tempDir, 'turbo_trades_2026-07-28.jsonl');
    const record = (tradeId: string) => ({
      trade_id: tradeId,
      closed_at: '2026-07-27T01:30:00.000Z',
      pnl_usdt: -1,
      status: 'CLOSED',
      strategy: 'MICRO_BURST',
      mode: 'AEGIS_TURBO_MICRO_LIVE',
      owner: 'AEGIS',
      origin: 'BOT',
      ownership_status: 'VERIFIED',
      eligible_for_bot_metrics: true,
    });
    await fs.writeFile(first, `${JSON.stringify(record('old'))}\n`);
    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toHaveLength(1);

    await fs.writeFile(first, `${JSON.stringify(record('replacement'))}\n`);
    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toEqual([
      expect.objectContaining({ tradeId: 'replacement' }),
    ]);

    await fs.writeFile(first, '');
    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toEqual([]);
    const complete = JSON.stringify(record('complete'));
    await fs.writeFile(first, complete.slice(0, -1));
    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toEqual([]);
    await fs.appendFile(first, '}\n');
    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toHaveLength(1);

    await fs.rename(first, second);
    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toEqual([
      expect.objectContaining({ tradeId: 'complete' }),
    ]);
  });

  it('returns the same complete-file accounting on cold and warm reads', async () => {
    const files = ['2026-07-27', '2026-07-28', '2026-07-29'];
    const records = files.flatMap((day, index) =>
      Array.from({ length: 100 }, (_, offset) => ({
        trade_id: `MICRO-BURST-${index}-${offset}`,
        closed_at: `${day}T01:30:00.000Z`,
        pnl_usdt: offset % 2 ? -1 : 2,
        status: 'CLOSED',
        strategy: 'MICRO_BURST',
        mode: 'AEGIS_TURBO_MICRO_LIVE',
        owner: 'AEGIS',
        origin: 'BOT',
        ownership_status: 'VERIFIED',
        eligible_for_bot_metrics: true,
      })),
    );
    for (const day of files) {
      await fs.writeFile(
        path.join(tempDir, `turbo_trades_${day}.jsonl`),
        `${records
          .filter((record) => record.closed_at.startsWith(day))
          .map((record) => JSON.stringify(record))
          .join('\n')}\n`,
      );
    }
    const coldStartedAt = performance.now();
    const cold = await readStrategyClosedTradeOutcomes(tempDir);
    const coldDurationMs = performance.now() - coldStartedAt;
    const warmStartedAt = performance.now();
    const warm = await readStrategyClosedTradeOutcomes(tempDir);
    const warmDurationMs = performance.now() - warmStartedAt;
    expect(warm).toEqual(cold);
    expect(warm).toHaveLength(records.length);
    // Keep this as an observation, not a flaky wall-clock threshold.
    expect(Number.isFinite(coldDurationMs) && Number.isFinite(warmDurationMs)).toBe(true);
    console.info(
      `micro-history-reader-benchmark coldMs=${coldDurationMs.toFixed(2)} warmMs=${warmDurationMs.toFixed(2)} records=${records.length}`,
    );
  });
});
