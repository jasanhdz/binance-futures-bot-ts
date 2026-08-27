import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
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

  it('loads verified Aegis and Momentum outcomes for account-wide reconstruction', async () => {
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
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
    );

    await expect(readStrategyClosedTradeOutcomes(tempDir)).resolves.toHaveLength(2);
  });
});
