import type { MicroOpportunityPredictionV1 } from './MicroOpportunityPredictionContract';
import type { MicroOpportunityGateDecision } from './MicroOpportunityGate';

export interface MicroOpportunityDualRunRecord {
  readonly observedAtMs: number;
  readonly symbol: string;
  readonly stableDecision: 'ENTRY_INTENT' | 'NO_TRADE';
  readonly stableSide: 'LONG' | 'SHORT' | null;
  readonly opportunity: MicroOpportunityPredictionV1 | null;
  readonly gate: MicroOpportunityGateDecision;
  readonly executionAuthority: 'STABLE_MICRO_ONLY';
}

export function buildMicroOpportunityDualRunRecord(input: Omit<MicroOpportunityDualRunRecord, 'executionAuthority'>): MicroOpportunityDualRunRecord {
  return Object.freeze({ ...input, executionAuthority: 'STABLE_MICRO_ONLY' as const });
}
