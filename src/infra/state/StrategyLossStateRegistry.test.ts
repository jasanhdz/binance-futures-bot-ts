import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StrategyLossStateRegistry } from './StrategyLossStateRegistry';

const ORIGINAL_CWD = process.cwd();

describe('StrategyLossStateRegistry', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strategy-loss-registry-'));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(ORIGINAL_CWD);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('tracks Aegis, Momentum, Micro Burst and manual independently', async () => {
    const registry = new StrategyLossStateRegistry();
    const mode = 'LIVE';

    await registry.record('AEGIS_TURBO', mode, {
      tradeId: 'a-1',
      closedAt: '2026-08-29T20:00:00.000Z',
      pnlUsdt: -1,
    });
    await registry.record('MOMENTUM_RIDE', mode, {
      tradeId: 'm-1',
      closedAt: '2026-08-29T20:01:00.000Z',
      pnlUsdt: -2,
    });
    await registry.record('MOMENTUM_RIDE', mode, {
      tradeId: 'm-2',
      closedAt: '2026-08-29T20:02:00.000Z',
      pnlUsdt: -3,
    });
    await registry.record('MICRO_BURST_V1', mode, {
      tradeId: 'b-1',
      closedAt: '2026-08-29T20:03:00.000Z',
      pnlUsdt: 2,
    });
    await registry.record('MANUAL', mode, {
      tradeId: 'manual-1',
      closedAt: '2026-08-29T20:04:00.000Z',
      pnlUsdt: -0.5,
    });

    expect(registry.trackerValue('AEGIS_TURBO')).toBe(1);
    expect(registry.trackerValue('MOMENTUM_RIDE')).toBe(2);
    expect(registry.trackerValue('MICRO_BURST_V1')).toBe(0);
    expect(registry.trackerValue('MANUAL')).toBe(1);

    const momentum = await registry.storeFor('MOMENTUM_RIDE').read(mode);
    expect(momentum?.strategy_id).toBe('MOMENTUM_RIDE');
    expect(momentum?.total_losses).toBe(2);
    expect(momentum?.consecutive_losses).toBe(2);
  });

  it('supports a future strategy without adding a new store class', async () => {
    const registry = new StrategyLossStateRegistry();
    const state = await registry.record('FUTURE_STRATEGY_X', 'SHADOW', {
      tradeId: 'future-1',
      closedAt: '2026-08-29T21:00:00.000Z',
      pnlUsdt: -1,
    });
    expect(state.strategy_id).toBe('FUTURE_STRATEGY_X');
    expect(state.consecutive_losses).toBe(1);
  });
});
