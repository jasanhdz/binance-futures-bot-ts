import { AegisEntryIntelligenceShadowBlock } from './AegisStrategy';

export type AegisOperationalDispositionStage = 'MICRO_GATE' | 'ENTRY_POLICY';

export interface AegisOperationalDispositionShadowInput {
  symbol: string;
  stage: AegisOperationalDispositionStage;
  intelligence?: AegisEntryIntelligenceShadowBlock;
  operationalAllowed: boolean;
  operationalReason: string;
  deniedBy?: string;
}

export interface AegisOperationalDispositionShadowRecord {
  schemaId: 'aegis-operational-disposition-shadow-v1';
  mode: 'SHADOW';
  symbol: string;
  stage: AegisOperationalDispositionStage;
  decisionCycleId?: string;
  marketTimestamp?: string;
  pythonCanonicalRank?: number;
  pythonTimingRank?: number;
  pythonTimingState?: string;
  operationalAllowed: boolean;
  operationalReason: string;
  deniedBy?: string;
  fallbackToNextCandidate: 'NOT_IMPLEMENTED_OBSERVATION_ONLY';
  selectionEffect: 'NONE';
  exchangeAuthority: false;
  exchangeMutations: 0;
}

export function buildAegisOperationalDispositionShadow(
  input: AegisOperationalDispositionShadowInput,
): AegisOperationalDispositionShadowRecord | undefined {
  if (input.intelligence?.mode !== 'SHADOW') return undefined;
  return {
    schemaId: 'aegis-operational-disposition-shadow-v1',
    mode: 'SHADOW',
    symbol: input.symbol,
    stage: input.stage,
    decisionCycleId: input.intelligence.decision_cycle_id,
    marketTimestamp: input.intelligence.market_timestamp,
    pythonCanonicalRank: input.intelligence.current_symbol_canonical_rank,
    pythonTimingRank: input.intelligence.current_symbol_timing_rank,
    pythonTimingState: input.intelligence.entry_timing_shadow?.state,
    operationalAllowed: input.operationalAllowed,
    operationalReason: input.operationalReason,
    deniedBy: input.deniedBy,
    fallbackToNextCandidate: 'NOT_IMPLEMENTED_OBSERVATION_ONLY',
    selectionEffect: 'NONE',
    exchangeAuthority: false,
    exchangeMutations: 0,
  };
}
