import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsStateStore } from './FsStateStore';

describe('FsStateStore', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-state-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('round-trips daily risk state', async () => {
    const state = new FsStateStore('default', 'test', directory);
    state.set({
      dailyRisk: {
        dayKey: 20600,
        tradesToday: 2,
        strategyTradesToday: { AEGIS_TURBO: 1, MOMENTUM_RIDE: 1 },
        dailyStartBalance: 20,
      },
    });
    await state.flush();

    expect(new FsStateStore('default', 'test', directory).get().dailyRisk).toEqual({
      dayKey: 20600,
      tradesToday: 2,
      strategyTradesToday: { AEGIS_TURBO: 1, MOMENTUM_RIDE: 1 },
      dailyStartBalance: 20,
    });
  });

  it('preserves the stop submission latch across a fresh store instance', async () => {
    const state = new FsStateStore('default', 'test', directory);
    const submission = { attemptedAt: 1234, stopPrice: 99, tradeId: 'micro-1' };
    state.set({ microProtectionBlocked: true, microStopSubmission: submission });
    await state.flush();
    expect(new FsStateStore('default', 'test', directory).get()).toMatchObject({
      microProtectionBlocked: true,
      microStopSubmission: submission,
    });
  });

  it.each([
    { attemptedAt: -1, stopPrice: 99 },
    { attemptedAt: 1234, stopPrice: 0 },
    { attemptedAt: '1234', stopPrice: 99 },
    null,
  ])('rejects malformed persisted stop submission %j', async (microStopSubmission) => {
    await fs.writeFile(
      path.join(directory, 'state_TEST.json'),
      JSON.stringify({ mode: 'LONG_RIDE', microStopSubmission }),
    );
    expect(() => new FsStateStore('default', 'test', directory)).toThrow('BOT_STATE_LOAD_FAILED');
  });

  it('flushes pending writes and keeps child stores in the custom directory', async () => {
    const state = new FsStateStore('default', 'test', directory);
    const child = state.forSymbol?.('ethusdt');
    expect(child).toBeDefined();
    child?.set({ lastTradeId: 'child-trade' });

    await child?.flush?.();

    expect(
      JSON.parse(
        await fs.readFile(path.join(directory, 'state_TEST_DEFAULT_ETHUSDT.json'), 'utf8'),
      ),
    ).toEqual(expect.objectContaining({ lastTradeId: 'child-trade' }));
  });

  it('fails closed for corrupt or incompatible state', async () => {
    await fs.writeFile(path.join(directory, 'state_TEST.json'), '{not-json');
    expect(() => new FsStateStore('default', 'test', directory)).toThrow('BOT_STATE_LOAD_FAILED');

    await fs.writeFile(path.join(directory, 'state_TEST.json'), JSON.stringify({ mode: 'BROKEN' }));
    expect(() => new FsStateStore('default', 'test', directory)).toThrow('BOT_STATE_LOAD_FAILED');
  });
});
