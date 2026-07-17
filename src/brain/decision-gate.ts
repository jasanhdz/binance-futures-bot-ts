/** Fail-closed translation from scientific proposals to existing operational gates. */

import { DecisionResponse } from './contract';

export interface OperationalContext {
  now: string; allowedSymbols: readonly string[]; allowedSides: readonly ('LONG' | 'SHORT')[];
  killSwitchActive: boolean; explicitAuthorization: boolean; executionEnabledByConfig: boolean;
  availableSlots: number; occupiedSymbols: readonly string[]; expectedModelBundleId: string;
  expectedSymbolSetHash: string; expectedFeatureSchemaVersion: string; maximumDecisionAgeMs: number;
  acceptedDecisionIds: ReadonlySet<string>;
}
export type GateDecision = 'ALLOW_EXISTING_ENTRY_FLOW' | 'DENY';
export interface GateResult { decision: GateDecision; reasonCodes: readonly string[]; decisionId: string; candidateId?: string; }
export interface DecisionGate { validate(decision: DecisionResponse, context: OperationalContext): GateResult; }

export class StrictDecisionGate implements DecisionGate {
  validate(response: DecisionResponse, context: OperationalContext): GateResult {
    const reasons: string[] = [];
    const now = Date.parse(context.now); const generatedAt = Date.parse(response.generated_at); const expiresAt = Date.parse(response.expires_at);
    if (!Number.isFinite(now) || !Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)) reasons.push('INVALID_DECISION_TIME');
    if (expiresAt <= now || now - generatedAt > context.maximumDecisionAgeMs) reasons.push('STALE_DECISION');
    if (response.model_bundle_id !== context.expectedModelBundleId) reasons.push('MODEL_BUNDLE_MISMATCH');
    if (response.symbol_set_hash !== context.expectedSymbolSetHash) reasons.push('SYMBOL_SET_HASH_MISMATCH');
    if (response.feature_schema_version !== context.expectedFeatureSchemaVersion) reasons.push('FEATURE_SCHEMA_MISMATCH');
    if (context.acceptedDecisionIds.has(response.decision_id)) reasons.push('DUPLICATE_DECISION');
    if (response.status === 'NO_TRADE') reasons.push('SCIENTIFIC_NO_TRADE');
    if (response.status !== 'SELECTED' || response.selected.length !== 1) reasons.push('INVALID_SELECTION_CARDINALITY');
    if (context.killSwitchActive) reasons.push('KILL_SWITCH_ACTIVE');
    if (!context.executionEnabledByConfig) reasons.push('EXECUTION_DISABLED_BY_CONFIG');
    if (!context.explicitAuthorization) reasons.push('EXPLICIT_AUTHORIZATION_REQUIRED');
    if (context.availableSlots < 1) reasons.push('NO_AVAILABLE_SLOT');
    const candidate = response.selected[0];
    if (candidate) {
      if (!candidate.eligible) reasons.push('CANDIDATE_NOT_ELIGIBLE');
      if (!context.allowedSymbols.includes(candidate.symbol)) reasons.push('SYMBOL_NOT_ALLOWED');
      if (candidate.side === 'NO_TRADE' || !context.allowedSides.includes(candidate.side)) reasons.push('SIDE_NOT_ALLOWED');
      if (context.occupiedSymbols.includes(candidate.symbol)) reasons.push('SYMBOL_OCCUPIED');
      if (candidate.model_bundle_id !== response.model_bundle_id || candidate.feature_hash.length !== 64) reasons.push('CANDIDATE_PARITY_MISMATCH');
    }
    return { decision: reasons.length ? 'DENY' : 'ALLOW_EXISTING_ENTRY_FLOW', reasonCodes: [...new Set(reasons)],
             decisionId: response.decision_id, candidateId: candidate?.candidate_id };
  }
}

export interface ExistingTradingFlowBridge { evaluateWithExistingOperationalGates(result: GateResult): Promise<void>; }
