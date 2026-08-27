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
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(new FsStateStore('default', 'test', directory).get().dailyRisk).toEqual({
      dayKey: 20600,
      tradesToday: 2,
      strategyTradesToday: { AEGIS_TURBO: 1, MOMENTUM_RIDE: 1 },
    });
  });

  it('fails closed for corrupt or incompatible state', async () => {
    await fs.writeFile(path.join(directory, 'state_TEST.json'), '{not-json');
    expect(() => new FsStateStore('default', 'test', directory)).toThrow('BOT_STATE_LOAD_FAILED');

    await fs.writeFile(path.join(directory, 'state_TEST.json'), JSON.stringify({ mode: 'BROKEN' }));
    expect(() => new FsStateStore('default', 'test', directory)).toThrow('BOT_STATE_LOAD_FAILED');
  });
});
