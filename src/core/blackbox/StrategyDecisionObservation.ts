import type {
  MarketSnapshotProvider,
  MarketSnapshotRequest,
  MarketSnapshotV1,
} from '../market-data/MarketSnapshotProvider';
import type { StrategyDecisionEnvelope } from '../strategy/StrategyDecision';
import type { StrategyId } from '../strategy/StrategyIdentity';
import type { StrategyDecisionBlackBox } from './StrategyDecisionBlackBox';

export interface StrategyDecisionObservationHook<TContext = unknown> {
  beforeEvaluation(strategyId: StrategyId, context: TContext): Promise<MarketSnapshotV1 | null>;
  afterEvaluation(snapshot: MarketSnapshotV1, decision: StrategyDecisionEnvelope): Promise<void>;
}

export interface StrategyDecisionObservationHealth {
  captureAttempted: number;
  captureSucceeded: number;
  captureFailed: number;
  decisionsObserved: number;
}

export type StrategySnapshotRequestFactory<TContext> = (
  strategyId: StrategyId,
  context: TContext,
) => MarketSnapshotRequest | null;

/**
 * Phase T observational adapter.
 *
 * Snapshot capture happens before strategy evaluation so every persisted market snapshot is on the
 * causal side of the decision boundary. Failures are intentionally fail-open: neither capture nor
 * evidence persistence is allowed to change a strategy decision.
 */
export class BlackBoxStrategyDecisionObservation<TContext = unknown>
  implements StrategyDecisionObservationHook<TContext>
{
  private readonly metrics: StrategyDecisionObservationHealth = {
    captureAttempted: 0,
    captureSucceeded: 0,
    captureFailed: 0,
    decisionsObserved: 0,
  };

  constructor(
    private readonly snapshotProvider: MarketSnapshotProvider,
    private readonly blackBox: StrategyDecisionBlackBox,
    private readonly requestFactory: StrategySnapshotRequestFactory<TContext>,
  ) {}

  async beforeEvaluation(
    strategyId: StrategyId,
    context: TContext,
  ): Promise<MarketSnapshotV1 | null> {
    let request: MarketSnapshotRequest | null;
    try {
      request = this.requestFactory(strategyId, context);
    } catch {
      this.metrics.captureFailed += 1;
      return null;
    }
    if (!request) return null;

    this.metrics.captureAttempted += 1;
    try {
      const snapshot = await this.snapshotProvider.capture(request);
      this.metrics.captureSucceeded += 1;
      return snapshot;
    } catch {
      this.metrics.captureFailed += 1;
      return null;
    }
  }

  async afterEvaluation(
    snapshot: MarketSnapshotV1,
    decision: StrategyDecisionEnvelope,
  ): Promise<void> {
    await this.blackBox.observe(snapshot, decision);
    this.metrics.decisionsObserved += 1;
  }

  health(): Readonly<StrategyDecisionObservationHealth> {
    return { ...this.metrics };
  }
}
