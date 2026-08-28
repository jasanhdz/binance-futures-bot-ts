import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  AegisTurboHistoryLogger,
  generateStrategyTradeId,
  generateTradeId,
} from './AegisTurboHistoryLogger';

describe('AegisTurboHistoryLogger', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-history-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates logs/aegis directory', async () => {
    const baseDir = path.join(tempDir, 'logs', 'aegis');
    const logger = new AegisTurboHistoryLogger({ baseDir });

    await logger.logSignal({
      timestamp: '2026-05-06T10:15:00.000Z',
      symbol: 'ETHUSDT',
      strategy: 'AEGIS_TURBO',
      mode: 'AEGIS_SHADOW',
    });

    const stat = await fs.stat(baseDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('writes valid JSONL', async () => {
    const logger = new AegisTurboHistoryLogger({ baseDir: tempDir });

    await logger.logSignal({
      timestamp: '2026-05-06T10:15:00.000Z',
      symbol: 'ETHUSDT',
      strategy: 'AEGIS_TURBO',
      mode: 'AEGIS_TURBO_MICRO_LIVE',
      turbo_score: 0.72,
    });

    const content = await fs.readFile(path.join(tempDir, 'turbo_signals_2026-05-06.jsonl'), 'utf8');
    expect(JSON.parse(content.trim())).toMatchObject({ symbol: 'ETHUSDT', turbo_score: 0.72 });
  });

  it('includes symbol', async () => {
    const logger = new AegisTurboHistoryLogger({ baseDir: tempDir });

    await logger.logTradeEvent({
      timestamp: '2026-05-06T10:15:00.000Z',
      symbol: 'BTCUSDT',
      strategy: 'AEGIS_TURBO',
      mode: 'AEGIS_TURBO_MICRO_LIVE',
      event: 'GATE_DENIED',
    });

    const content = await fs.readFile(
      path.join(tempDir, 'turbo_trade_events_2026-05-06.jsonl'),
      'utf8',
    );
    expect(JSON.parse(content.trim()).symbol).toBe('BTCUSDT');
  });

  it('uses date files, not symbol files', async () => {
    const logger = new AegisTurboHistoryLogger({ baseDir: tempDir });

    await logger.logSignal({
      timestamp: '2026-05-06T10:15:00.000Z',
      symbol: 'SOLUSDT',
      strategy: 'AEGIS_TURBO',
      mode: 'AEGIS_SHADOW',
    });

    const files = await fs.readdir(tempDir);
    expect(files).toContain('turbo_signals_2026-05-06.jsonl');
    expect(files.some((file) => file.includes('SOLUSDT'))).toBe(false);
  });

  it('does not throw on logging failure', async () => {
    const baseDir = path.join(tempDir, 'not-a-dir');
    await fs.writeFile(baseDir, 'file');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = new AegisTurboHistoryLogger({ baseDir });

    await expect(
      logger.logSignal({
        timestamp: '2026-05-06T10:15:00.000Z',
        symbol: 'ETHUSDT',
        strategy: 'AEGIS_TURBO',
        mode: 'AEGIS_SHADOW',
      }),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      'aegis_turbo_history_write_failed',
      expect.anything(),
    );
  });

  it('sanitizes NaN and Infinity', async () => {
    const logger = new AegisTurboHistoryLogger({ baseDir: tempDir });

    await logger.logSignal({
      timestamp: '2026-05-06T10:15:00.000Z',
      symbol: 'ETHUSDT',
      strategy: 'AEGIS_TURBO',
      mode: 'AEGIS_SHADOW',
      turbo_score: Number.NaN,
      metadata: { value: Number.POSITIVE_INFINITY },
    });

    const content = await fs.readFile(path.join(tempDir, 'turbo_signals_2026-05-06.jsonl'), 'utf8');
    const row = JSON.parse(content.trim());
    expect(row.turbo_score).toBeNull();
    expect(row.metadata.value).toBeNull();
  });

  it('preserves MOMENTUM_RIDE attribution on close and lifecycle events', async () => {
    const logger = new AegisTurboHistoryLogger({ baseDir: tempDir });
    const ownership = {
      owner: 'AEGIS' as const,
      origin: 'BOT' as const,
      ownership_status: 'VERIFIED' as const,
      eligible_for_bot_metrics: true,
      exclusion_reason: null,
    };

    await logger.logTradeClose({
      ...ownership,
      timestamp: '2026-08-26T10:15:00.000Z',
      trade_id: 'MOMENTUM-RIDE-SUIUSDT-1',
      symbol: 'SUIUSDT',
      strategy: 'MOMENTUM_RIDE',
      mode: 'LIVE',
      closed_at: '2026-08-26T10:15:00.000Z',
      exit_reason: 'TEST_EXIT',
      status: 'CLOSED',
      strategy_version: 'legacy-unfrozen',
      code_commit_sha: 'test-sha',
    });
    await logger.logTradeEvent({
      timestamp: '2026-08-26T10:15:00.000Z',
      trade_id: 'MOMENTUM-RIDE-SUIUSDT-1',
      symbol: 'SUIUSDT',
      strategy: 'MOMENTUM_RIDE',
      mode: 'LIVE',
      event: 'TRADE_CLOSED',
    });

    const trades = await fs.readFile(path.join(tempDir, 'turbo_trades_2026-08-26.jsonl'), 'utf8');
    const events = await fs.readFile(
      path.join(tempDir, 'turbo_trade_events_2026-08-26.jsonl'),
      'utf8',
    );
    expect(JSON.parse(trades.trim()).strategy).toBe('MOMENTUM_RIDE');
    expect(JSON.parse(events.trim()).strategy).toBe('MOMENTUM_RIDE');
  });

  it('keeps legacy Aegis trade ids stable and supports strategy-specific ids', () => {
    const timestamp = new Date('2026-08-26T10:15:00.123Z');
    expect(generateTradeId('SUIUSDT', timestamp)).toBe('AEGIS-TURBO-SUIUSDT-20260826-101500-123');
    expect(generateStrategyTradeId('MOMENTUM_RIDE', 'SUIUSDT', timestamp)).toBe(
      'MOMENTUM-RIDE-SUIUSDT-20260826-101500-123',
    );
  });
});
