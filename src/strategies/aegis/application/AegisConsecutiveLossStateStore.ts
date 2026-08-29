import path from 'path';
import {
  StrategyLossState,
  StrategyLossStateStore,
  StrategyLossStateStorePort,
} from '../../../infra/state/StrategyLossStateStore';

export const AEGIS_CONSECUTIVE_LOSS_STATE_SCHEMA = 'aegis-consecutive-loss-state-v1';

export type AegisConsecutiveLossState = StrategyLossState & {
  schema_id: typeof AEGIS_CONSECUTIVE_LOSS_STATE_SCHEMA;
};

export interface AegisConsecutiveLossStateStorePort {
  read(mode: string): Promise<AegisConsecutiveLossState | null>;
  write(state: AegisConsecutiveLossState): Promise<void>;
}

/** Aegis-specific persistence specialization over the generic strategy loss store. */
export class AegisConsecutiveLossStateStore
  extends StrategyLossStateStore
  implements AegisConsecutiveLossStateStorePort
{
  constructor(
    filePath = path.join(process.cwd(), 'data', 'runtime', 'aegis_consecutive_loss_state.json'),
  ) {
    super({
      filePath,
      schemaId: AEGIS_CONSECUTIVE_LOSS_STATE_SCHEMA,
      invalidStateError: 'AEGIS_CONSECUTIVE_LOSS_STATE_INVALID',
    });
  }

  async read(mode: string): Promise<AegisConsecutiveLossState | null> {
    return (await super.read(mode)) as AegisConsecutiveLossState | null;
  }

  async write(state: AegisConsecutiveLossState): Promise<void> {
    await super.write(state);
  }
}

export type { StrategyLossState, StrategyLossStateStorePort };
