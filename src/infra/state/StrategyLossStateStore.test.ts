import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STRATEGY_LOSS_STATE_SCHEMA, StrategyLossStateStore } from './StrategyLossStateStore';

describe('StrategyLossStateStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strategy-loss-state-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('migrates the legacy Aegis state into the canonical strategy-scoped schema', async () => {
    const legacyPath = path.join(tempDir, 'aegis-legacy.json');
    const canonicalPath = path.join(tempDir, 'strategy-loss', 'aegis.json');
    const fixturePath = path.join(__dirname, 'fixtures', 'aegis-consecutive-loss-state-v1.json');
    await fs.copyFile(fixturePath, legacyPath);

    const store = new StrategyLossStateStore({
      strategyId: 'AEGIS_TURBO',
      filePath: canonicalPath,
      legacy: { filePath: legacyPath, schemaId: 'aegis-consecutive-loss-state-v1' },
    });

    const state = await store.read('AEGIS_TURBO_MICRO_LIVE');
    expect(state).toMatchObject({
      schema_id: STRATEGY_LOSS_STATE_SCHEMA,
      strategy_id: 'AEGIS_TURBO',
      consecutive_losses: 3,
    });
    const persisted = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
    expect(persisted.strategy_id).toBe('AEGIS_TURBO');
  });

  it('keeps invalid-state failure configurable', async () => {
    const statePath = path.join(tempDir, 'state.json');
    await fs.writeFile(statePath, JSON.stringify({ schema_id: 'wrong' }));
    const store = new StrategyLossStateStore({
      strategyId: 'TEST',
      filePath: statePath,
      invalidStateError: 'CUSTOM_LOSS_STATE_INVALID',
    });
    await expect(store.read('LIVE')).rejects.toThrow('CUSTOM_LOSS_STATE_INVALID');
  });
});
