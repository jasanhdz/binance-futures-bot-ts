import type { Side } from '../../../core/types';
import type { MarketSnapshotV1 } from '../../../core/market-data/MarketSnapshotProvider';
import { AegisEntryGuardOrchestrator } from '../domain/entry/AegisEntryGuardOrchestrator';
import type {
  AegisEntryContext,
  AegisEntryDecisionResult,
  AegisEntryPolicyRuntimeConfig,
} from '../domain/entry/AegisEntryDecisionTypes';
import {
  evaluateAegisEntrySafetyConsensus,
  type AegisEntrySafetyConsensusConfig,
  type AegisEntrySafetyConsensusDecision,
} from '../domain/services/AegisEntrySafetyConsensus';

export interface AegisEntryDecisionInput {
  context: AegisEntryContext;
  side: Side;
  policy: AegisEntryPolicyRuntimeConfig;
  consensusConfig?: AegisEntrySafetyConsensusConfig;
}

export interface AegisEntryResult {
  entryDecision: AegisEntryDecisionResult;
  safetyConsensus: AegisEntrySafetyConsensusDecision;
}

export interface AegisEntryEvaluationInput extends AegisEntryDecisionInput {
  captureDecision?: () => Promise<MarketSnapshotV1 | null | undefined>;
}

export interface AegisEntryEvaluation extends AegisEntryResult {
  /** Causal snapshot captured immediately before the policy evaluation. */
  blackBoxSnapshot: MarketSnapshotV1 | null | undefined;
}

/**
 * Coordinates the pure Aegis entry decision without owning execution or
 * decision side effects. TradingService remains responsible for those steps.
 */
export class AegisEntryCoordinator {
  async evaluate(input: AegisEntryEvaluationInput): Promise<AegisEntryEvaluation> {
    const blackBoxSnapshot = input.captureDecision ? await input.captureDecision() : undefined;
    const { context, side, policy, consensusConfig } = input;
    const result = await this.decide({ context, side, policy, consensusConfig });
    return { ...result, blackBoxSnapshot };
  }

  async decide(input: AegisEntryDecisionInput): Promise<AegisEntryResult> {
    const entryDecision = await AegisEntryGuardOrchestrator.evaluate(input.context, input.policy);
    const safetyConsensus = evaluateAegisEntrySafetyConsensus({
      side: input.side,
      entryDecision,
      config: input.consensusConfig,
    });

    return { entryDecision, safetyConsensus };
  }
}
