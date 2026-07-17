/** Bridge from a scientific proposal to the existing TypeScript operational gates. */

import { DecisionResponse } from './contract';

export interface OperationalContext {
  now: string;
  allowedSymbols: readonly string[];
  allowedSides: readonly ('LONG' | 'SHORT')[];
  killSwitchActive: boolean;
  explicitAuthorization: boolean;
  availableSlots: number;
  occupiedSymbols: readonly string[];
  expectedModelBundleId: string;
  expectedSymbolSetHash: string;
}

export type GateDecision = 'ALLOW_EXISTING_ENTRY_FLOW' | 'DENY';

export interface GateResult {
  decision: GateDecision;
  reasonCodes: readonly string[];
  decisionId: string;
  candidateId?: string;
}

export interface DecisionGate {
  validate(decision: DecisionResponse, context: OperationalContext): GateResult;
}

/**
 * TODO: adapt an allowed scientific candidate into the current TradingService
 * entry flow. AegisEntryGuardOrchestrator and the existing exchange/risk ports
 * remain authoritative; this module must not duplicate their logic.
 */
export interface ExistingTradingFlowBridge {
  evaluateWithExistingOperationalGates(result: GateResult): Promise<void>;
}
