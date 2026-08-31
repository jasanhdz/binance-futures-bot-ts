import type { Side } from '../../../core/types';
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

/**
 * Coordinates the pure Aegis entry decision without owning execution or
 * decision side effects. TradingService remains responsible for those steps.
 */
export class AegisEntryCoordinator {
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
