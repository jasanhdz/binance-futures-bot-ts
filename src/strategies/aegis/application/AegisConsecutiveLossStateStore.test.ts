import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AEGIS_CONSECUTIVE_LOSS_STATE_SCHEMA,
  AegisConsecutiveLossStateStore,
} from './AegisConsecutiveLossStateStore';

describe('AegisConsecutiveLossStateStore', () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-loss-state-'));
    statePath = path.join(tempDir, 'state.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('persists and reloads the exact counter', async () => {
    const store = new AegisConsecutiveLossStateStore(statePath);
    const state = {
      schema_id: AEGIS_CONSECUTIVE_LOSS_STATE_SCHEMA,
      mode: 'AEGIS_TURBO_MICRO_LIVE',
      consecutive_losses: 0,
      updated_at: '2026-08-02T22:45:00.000Z',
      last_trade_id: null,
      reset_authority: 'OWNER_AUTHORIZED_HYBRID_LIVE_EXPERIMENT_LOSS_STREAK_RESET',
      reset_at: '2026-08-02T22:45:00.000Z',
    } as const;

    await store.write(state);
    await expect(store.read(state.mode)).resolves.toEqual(state);
    expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it('fails closed for malformed or cross-mode state', async () => {
    const store = new AegisConsecutiveLossStateStore(statePath);
    await fs.writeFile(statePath, JSON.stringify({ consecutive_losses: -1, mode: 'SHADOW' }));

    await expect(store.read('AEGIS_TURBO_MICRO_LIVE')).rejects.toThrow(
      'AEGIS_CONSECUTIVE_LOSS_STATE_INVALID',
    );
  });
});
