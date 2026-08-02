import { promises as fs } from 'fs';
import path from 'path';

export const AEGIS_CONSECUTIVE_LOSS_STATE_SCHEMA = 'aegis-consecutive-loss-state-v1';

export type AegisConsecutiveLossState = {
  schema_id: typeof AEGIS_CONSECUTIVE_LOSS_STATE_SCHEMA;
  mode: string;
  consecutive_losses: number;
  updated_at: string;
  last_trade_id: string | null;
  reset_authority: string;
  reset_at: string;
};

export interface AegisConsecutiveLossStateStorePort {
  read(mode: string): Promise<AegisConsecutiveLossState | null>;
  write(state: AegisConsecutiveLossState): Promise<void>;
}

export class AegisConsecutiveLossStateStore implements AegisConsecutiveLossStateStorePort {
  constructor(
    private readonly filePath = path.join(
      process.cwd(),
      'data',
      'runtime',
      'aegis_consecutive_loss_state.json',
    ),
  ) {}

  async read(mode: string): Promise<AegisConsecutiveLossState | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const state = JSON.parse(raw) as Partial<AegisConsecutiveLossState>;
    if (
      state.schema_id !== AEGIS_CONSECUTIVE_LOSS_STATE_SCHEMA ||
      state.mode !== mode ||
      !Number.isInteger(state.consecutive_losses) ||
      (state.consecutive_losses ?? -1) < 0 ||
      typeof state.updated_at !== 'string' ||
      !Number.isFinite(Date.parse(state.updated_at)) ||
      (state.last_trade_id !== null && typeof state.last_trade_id !== 'string') ||
      typeof state.reset_authority !== 'string' ||
      !state.reset_authority ||
      typeof state.reset_at !== 'string' ||
      !Number.isFinite(Date.parse(state.reset_at))
    ) {
      throw new Error('AEGIS_CONSECUTIVE_LOSS_STATE_INVALID');
    }

    return state as AegisConsecutiveLossState;
  }

  async write(state: AegisConsecutiveLossState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }
}
