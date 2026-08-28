import { promises as fs } from 'fs';
import path from 'path';

export type StrategyLossState = {
  schema_id: string;
  mode: string;
  consecutive_losses: number;
  updated_at: string;
  last_trade_id: string | null;
  reset_authority: string;
  reset_at: string;
};

export interface StrategyLossStateStorePort {
  read(mode: string): Promise<StrategyLossState | null>;
  write(state: StrategyLossState): Promise<void>;
}

export class StrategyLossStateStore implements StrategyLossStateStorePort {
  private readonly filePath: string;
  private readonly schemaId: string;
  private readonly invalidStateError: string;

  constructor(options: { filePath: string; schemaId: string; invalidStateError?: string }) {
    this.filePath = options.filePath;
    this.schemaId = options.schemaId;
    this.invalidStateError = options.invalidStateError ?? 'STRATEGY_LOSS_STATE_INVALID';
  }

  async read(mode: string): Promise<StrategyLossState | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const state = JSON.parse(raw) as Partial<StrategyLossState>;
    if (
      state.schema_id !== this.schemaId ||
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
      throw new Error(this.invalidStateError);
    }
    return state as StrategyLossState;
  }

  async write(state: StrategyLossState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }
}
