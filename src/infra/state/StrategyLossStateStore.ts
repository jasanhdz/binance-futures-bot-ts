import { promises as fs } from 'fs';
import path from 'path';

export const STRATEGY_LOSS_STATE_SCHEMA = 'strategy-loss-state-v2' as const;

export type StrategyLossResult = 'WIN' | 'LOSS' | 'BREAKEVEN' | null;

export type StrategyLossState = {
  schema_id: typeof STRATEGY_LOSS_STATE_SCHEMA;
  strategy_id: string;
  mode: string;
  consecutive_losses: number;
  total_losses: number;
  total_wins: number;
  last_result: StrategyLossResult;
  updated_at: string;
  last_trade_id: string | null;
  reset_authority: string;
  reset_at: string;
};

export type StrategyLossStateWrite = Omit<StrategyLossState, 'schema_id' | 'strategy_id'> & {
  schema_id?: string;
  strategy_id?: string;
};

export interface StrategyLossStateStorePort {
  readonly strategyId: string;
  read(mode: string): Promise<StrategyLossState | null>;
  write(state: StrategyLossStateWrite): Promise<void>;
}

export interface StrategyLossStateStoreOptions {
  strategyId: string;
  filePath?: string;
  invalidStateError?: string;
  legacy?: {
    filePath: string;
    schemaId: string;
  };
}

const safeStrategyFileName = (strategyId: string): string =>
  strategyId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

/**
 * Generic durable loss-state store scoped by strategy identity.
 *
 * The persistence mechanism knows nothing about Aegis, Momentum, Micro Burst or
 * manual trading. Strategy-specific reactions to the stored streak belong to the
 * strategy/risk-policy layer.
 */
export class StrategyLossStateStore implements StrategyLossStateStorePort {
  readonly strategyId: string;
  private readonly filePath: string;
  private readonly invalidStateError: string;
  private readonly legacy?: StrategyLossStateStoreOptions['legacy'];

  constructor(options: StrategyLossStateStoreOptions) {
    if (!options.strategyId.trim()) throw new Error('STRATEGY_ID_REQUIRED');
    this.strategyId = options.strategyId.trim().toUpperCase();
    this.filePath =
      options.filePath ??
      path.join(
        process.cwd(),
        'data',
        'runtime',
        'strategy-loss',
        `${safeStrategyFileName(this.strategyId)}.json`,
      );
    this.invalidStateError = options.invalidStateError ?? 'STRATEGY_LOSS_STATE_INVALID';
    this.legacy = options.legacy;
  }

  async read(mode: string): Promise<StrategyLossState | null> {
    const canonical = await this.readCanonical(mode);
    if (canonical) return canonical;
    return this.readLegacy(mode);
  }

  private async readCanonical(mode: string): Promise<StrategyLossState | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const state = JSON.parse(raw) as Partial<StrategyLossState>;
    this.assertValid(state, mode);
    return state as StrategyLossState;
  }

  private async readLegacy(mode: string): Promise<StrategyLossState | null> {
    if (!this.legacy) return null;
    let raw: string;
    try {
      raw = await fs.readFile(this.legacy.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const legacy = JSON.parse(raw) as Record<string, unknown>;
    if (
      legacy.schema_id !== this.legacy.schemaId ||
      legacy.mode !== mode ||
      !Number.isInteger(legacy.consecutive_losses) ||
      Number(legacy.consecutive_losses) < 0
    ) {
      throw new Error(this.invalidStateError);
    }
    const migrated: StrategyLossState = {
      schema_id: STRATEGY_LOSS_STATE_SCHEMA,
      strategy_id: this.strategyId,
      mode,
      consecutive_losses: Number(legacy.consecutive_losses),
      total_losses: 0,
      total_wins: 0,
      last_result: Number(legacy.consecutive_losses) > 0 ? 'LOSS' : null,
      updated_at:
        typeof legacy.updated_at === 'string' ? legacy.updated_at : new Date().toISOString(),
      last_trade_id: typeof legacy.last_trade_id === 'string' ? legacy.last_trade_id : null,
      reset_authority:
        typeof legacy.reset_authority === 'string'
          ? legacy.reset_authority
          : 'LEGACY_STATE_MIGRATION',
      reset_at: typeof legacy.reset_at === 'string' ? legacy.reset_at : new Date().toISOString(),
    };
    await this.write(migrated);
    return migrated;
  }

  private assertValid(state: Partial<StrategyLossState>, mode: string): void {
    if (
      state.schema_id !== STRATEGY_LOSS_STATE_SCHEMA ||
      state.strategy_id !== this.strategyId ||
      state.mode !== mode ||
      !Number.isInteger(state.consecutive_losses) ||
      (state.consecutive_losses ?? -1) < 0 ||
      !Number.isInteger(state.total_losses) ||
      (state.total_losses ?? -1) < 0 ||
      !Number.isInteger(state.total_wins) ||
      (state.total_wins ?? -1) < 0 ||
      ![null, 'WIN', 'LOSS', 'BREAKEVEN'].includes(state.last_result ?? null) ||
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
  }

  async write(input: StrategyLossStateWrite): Promise<void> {
    const state: StrategyLossState = {
      ...input,
      schema_id: STRATEGY_LOSS_STATE_SCHEMA,
      strategy_id: this.strategyId,
    };
    this.assertValid(state, state.mode);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }
}
