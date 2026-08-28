import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StrategyLossStateStore } from './StrategyLossStateStore';

describe('StrategyLossStateStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strategy-loss-state-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reads the legacy persisted schema and writes it back byte-for-byte', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'aegis-consecutive-loss-state-v1.json');
    const fixture = await fs.readFile(fixturePath, 'utf8');
    const statePath = path.join(tempDir, 'state.json');
    await fs.writeFile(statePath, fixture);
    const store = new StrategyLossStateStore({
      filePath: statePath,
      schemaId: 'aegis-consecutive-loss-state-v1',
    });

    const state = await store.read('AEGIS_TURBO_MICRO_LIVE');
    expect(state?.consecutive_losses).toBe(3);
    await store.write(state!);
    await expect(fs.readFile(statePath, 'utf8')).resolves.toBe(fixture);
  });

  it('keeps invalid-state failure configurable for compatibility adapters', async () => {
    const statePath = path.join(tempDir, 'state.json');
    await fs.writeFile(statePath, JSON.stringify({ schema_id: 'wrong' }));
    const store = new StrategyLossStateStore({
      filePath: statePath,
      schemaId: 'strategy-loss-state-v1',
      invalidStateError: 'CUSTOM_LOSS_STATE_INVALID',
    });
    await expect(store.read('LIVE')).rejects.toThrow('CUSTOM_LOSS_STATE_INVALID');
  });
});
