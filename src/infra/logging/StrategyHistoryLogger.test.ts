import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StrategyHistoryLogger } from './StrategyHistoryLogger';

describe('StrategyHistoryLogger', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strategy-history-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes deterministic generic JSONL while preserving event order', async () => {
    const logger = new StrategyHistoryLogger({ baseDir: tempDir });
    await logger.logSignal({
      timestamp: '2026-08-26T10:15:00.000Z',
      symbol: 'ETHUSDT',
      strategy: 'MOMENTUM_RIDE',
      mode: 'SHADOW',
      executed: false,
    });
    await logger.logTradeEvent({
      timestamp: '2026-08-26T10:15:00.001Z',
      symbol: 'ETHUSDT',
      strategy: 'MICRO_BURST_V1',
      mode: 'SHADOW',
      event: 'SIGNAL_RECEIVED',
    });

    const golden = await fs.readFile(
      path.join(__dirname, 'fixtures', 'strategy-history-signal.golden.jsonl'),
      'utf8',
    );
    await expect(fs.readFile(path.join(tempDir, 'signals_2026-08-26.jsonl'), 'utf8')).resolves.toBe(
      golden,
    );
    await expect(
      fs.readFile(path.join(tempDir, 'trade_events_2026-08-26.jsonl'), 'utf8'),
    ).resolves.toContain('"event":"SIGNAL_RECEIVED"');
  });

  it('can be configured with legacy file names without moving historical paths', async () => {
    const logger = new StrategyHistoryLogger({
      baseDir: tempDir,
      filePrefixes: {
        signals: 'turbo_signals',
        trades: 'turbo_trades',
        trade_events: 'turbo_trade_events',
        account_snapshots: 'account_snapshots',
      },
    });
    await logger.logSignal({
      timestamp: '2026-08-26T10:15:00.000Z',
      symbol: 'BTCUSDT',
      strategy: 'AEGIS_TURBO',
      mode: 'LIVE',
    });
    await expect(
      fs.stat(path.join(tempDir, 'turbo_signals_2026-08-26.jsonl')),
    ).resolves.toBeTruthy();
  });
});
