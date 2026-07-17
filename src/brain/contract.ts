/** Versioned scientific contract shared with the Python brain. */

export const BRAIN_CONTRACT_VERSION = 'aegis-clean-rebuild-v1' as const;
export type BrainContractVersion = typeof BRAIN_CONTRACT_VERSION;
export type ScientificSide = 'LONG' | 'SHORT' | 'NO_TRADE';
export type DecisionStatus = 'SELECTED' | 'NO_TRADE' | 'ERROR';
export type EvidenceMode = 'OPERATIONAL' | 'PAPER' | 'SHADOW' | 'REPLAY';

export interface Candle {
  open_time: string; close_time: string; open: number; high: number; low: number;
  close: number; volume: number; is_closed: boolean; source: string; sequence?: string;
}
export interface FeedQuality { missing_bars: number; duplicate_bars: number; source_lag_ms: number; }
export interface SymbolSeries { symbol: string; candles: readonly Candle[]; last_confirmed_close: string; feed_quality: FeedQuality; }
export interface PortfolioContext {
  blocked_symbols: readonly string[]; occupied_symbols: readonly string[]; available_slots: number;
  long_exposure_count: number; short_exposure_count: number; active_cooldowns: Readonly<Record<string, string>>;
  accepted_decision_ids: readonly string[]; operational_time?: string;
}
export interface MarketSnapshot {
  closed_at: string; timeframe: string; symbol_set_hash: string;
  series: readonly SymbolSeries[]; portfolio: PortfolioContext;
}
export interface DecisionRequest {
  request_id: string; decision_cycle_id: string; schema_version: string;
  contract_version: BrainContractVersion; config_version: string; snapshot: MarketSnapshot;
}
export interface RiskIntent {
  stop_distance_fraction?: number; target_distance_fraction?: number; volatility_multiple?: number;
  target_risk_ratio?: number; maximum_holding_bars?: number; scientific_invalidation?: string;
  relative_priority?: number;
}
export interface Candidate {
  candidate_id: string; symbol: string; side: ScientificSide; raw_score: number; calibrated_score: number;
  confidence: number; uncertainty: number; regime: string; compatibility: number; expected_return: number;
  horizon_bars: number; risk_intent: RiskIntent; reason_codes: readonly string[];
  evidence_references: readonly string[]; model_bundle_id: string; feature_hash: string;
  candidate_hash: string; eligible: boolean;
}
export interface RankedCandidate {
  rank: number; symbol: string; candidate_hash: string; score: number; eligible: boolean; reason_codes: readonly string[];
}
export interface DecisionResponse {
  contract_version: BrainContractVersion; decision_id: string; decision_cycle_id: string;
  generated_at: string; expires_at: string; status: DecisionStatus; universe_id: string;
  symbol_set_hash: string; config_version: string; model_bundle_id: string;
  feature_schema_version: string; evidence_hash: string; selected: readonly Candidate[];
  ranking: readonly RankedCandidate[]; reason_codes: readonly string[]; warnings: readonly string[];
}
export interface BrainManifest {
  contract_version: BrainContractVersion; universe_id: string; symbols: readonly string[];
  symbol_set_hash: string; timeframe: string; config_version: string; config_hash: string;
  model_bundle_id: string; feature_schema_version: string; feature_hash: string;
  capabilities: readonly string[]; build_id: string; ready: boolean;
}
export type OutcomeExecutionStatus = 'NOT_EXECUTED' | 'FILLED' | 'PARTIALLY_FILLED' | 'REJECTED' | 'INCIDENT';
export interface FillOutcome {
  status: OutcomeExecutionStatus; filled_quantity?: number; average_entry_price?: number; filled_at?: string;
}
export interface DecisionOutcome {
  decision_id: string; decision_cycle_id: string; candidate_hash?: string; accepted: boolean; executed: boolean;
  rejection_reason?: string; fill: FillOutcome; closed_at?: string; realized_pnl?: number;
  close_reason?: string; incidents: readonly string[]; reconciled: boolean; occurred_at: string;
  execution_mode?: EvidenceMode;
  hypothetical_details?: Readonly<Record<string, number | string | boolean>>;
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('BRAIN_CONTRACT_INVALID_OBJECT');
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`BRAIN_CONTRACT_INVALID_${name}`);
  return value;
};
const finite = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`BRAIN_CONTRACT_INVALID_${name}`);
  return value;
};
const texts = (value: unknown, name: string): readonly string[] => {
  if (!Array.isArray(value)) throw new Error(`BRAIN_CONTRACT_INVALID_${name}`);
  return value.map((item) => text(item, name));
};
const oneOf = <T extends string>(value: unknown, name: string, allowed: readonly T[]): T => {
  const parsed = text(value, name);
  if (!allowed.includes(parsed as T)) throw new Error(`BRAIN_CONTRACT_INVALID_${name}`);
  return parsed as T;
};

export function parseBrainManifest(value: unknown): BrainManifest {
  const item = record(value);
  return {
    contract_version: text(item.contract_version, 'CONTRACT_VERSION') as BrainContractVersion,
    universe_id: text(item.universe_id, 'UNIVERSE_ID'), symbols: texts(item.symbols, 'SYMBOLS'),
    symbol_set_hash: text(item.symbol_set_hash, 'SYMBOL_SET_HASH'), timeframe: text(item.timeframe, 'TIMEFRAME'),
    config_version: text(item.config_version, 'CONFIG_VERSION'), config_hash: text(item.config_hash, 'CONFIG_HASH'),
    model_bundle_id: text(item.model_bundle_id, 'MODEL_BUNDLE_ID'),
    feature_schema_version: text(item.feature_schema_version, 'FEATURE_SCHEMA_VERSION'),
    feature_hash: text(item.feature_hash, 'FEATURE_HASH'), capabilities: texts(item.capabilities, 'CAPABILITIES'),
    build_id: text(item.build_id, 'BUILD_ID'), ready: item.ready === true,
  };
}

function parseCandidate(value: unknown): Candidate {
  const item = record(value); const risk = record(item.risk_intent);
  const optionalNumber = (value: unknown): number | undefined => value === null || value === undefined ? undefined : finite(value, 'RISK_INTENT');
  return {
    candidate_id: text(item.candidate_id, 'CANDIDATE_ID'), symbol: text(item.symbol, 'SYMBOL'),
    side: oneOf(item.side, 'SIDE', ['LONG', 'SHORT', 'NO_TRADE']), raw_score: finite(item.raw_score, 'RAW_SCORE'),
    calibrated_score: finite(item.calibrated_score, 'CALIBRATED_SCORE'), confidence: finite(item.confidence, 'CONFIDENCE'),
    uncertainty: finite(item.uncertainty, 'UNCERTAINTY'), regime: text(item.regime, 'REGIME'),
    compatibility: finite(item.compatibility, 'COMPATIBILITY'), expected_return: finite(item.expected_return, 'EXPECTED_RETURN'),
    horizon_bars: finite(item.horizon_bars, 'HORIZON_BARS'), reason_codes: texts(item.reason_codes, 'REASON_CODES'),
    evidence_references: texts(item.evidence_references, 'EVIDENCE_REFERENCES'),
    model_bundle_id: text(item.model_bundle_id, 'MODEL_BUNDLE_ID'), feature_hash: text(item.feature_hash, 'FEATURE_HASH'),
    candidate_hash: text(item.candidate_hash, 'CANDIDATE_HASH'), eligible: item.eligible === true,
    risk_intent: {
      stop_distance_fraction: optionalNumber(risk.stop_distance_fraction), target_distance_fraction: optionalNumber(risk.target_distance_fraction),
      volatility_multiple: optionalNumber(risk.volatility_multiple), target_risk_ratio: optionalNumber(risk.target_risk_ratio),
      maximum_holding_bars: optionalNumber(risk.maximum_holding_bars),
      scientific_invalidation: typeof risk.scientific_invalidation === 'string' ? risk.scientific_invalidation : undefined,
      relative_priority: optionalNumber(risk.relative_priority),
    },
  };
}

export function parseDecisionResponse(value: unknown): DecisionResponse {
  const item = record(value);
  if (!Array.isArray(item.selected) || !Array.isArray(item.ranking)) throw new Error('BRAIN_CONTRACT_INVALID_DECISION_ARRAYS');
  return {
    contract_version: text(item.contract_version, 'CONTRACT_VERSION') as BrainContractVersion,
    decision_id: text(item.decision_id, 'DECISION_ID'), decision_cycle_id: text(item.decision_cycle_id, 'DECISION_CYCLE_ID'),
    generated_at: text(item.generated_at, 'GENERATED_AT'), expires_at: text(item.expires_at, 'EXPIRES_AT'),
    status: oneOf(item.status, 'STATUS', ['SELECTED', 'NO_TRADE', 'ERROR']), universe_id: text(item.universe_id, 'UNIVERSE_ID'),
    symbol_set_hash: text(item.symbol_set_hash, 'SYMBOL_SET_HASH'), config_version: text(item.config_version, 'CONFIG_VERSION'),
    model_bundle_id: text(item.model_bundle_id, 'MODEL_BUNDLE_ID'), feature_schema_version: text(item.feature_schema_version, 'FEATURE_SCHEMA_VERSION'),
    evidence_hash: text(item.evidence_hash, 'EVIDENCE_HASH'), selected: item.selected.map(parseCandidate),
    ranking: item.ranking.map((value) => { const rank = record(value); return {
      rank: finite(rank.rank, 'RANK'), symbol: text(rank.symbol, 'RANK_SYMBOL'), candidate_hash: text(rank.candidate_hash, 'RANK_HASH'),
      score: finite(rank.score, 'RANK_SCORE'), eligible: rank.eligible === true, reason_codes: texts(rank.reason_codes, 'RANK_REASONS'),
    }; }), reason_codes: texts(item.reason_codes, 'REASON_CODES'), warnings: texts(item.warnings ?? [], 'WARNINGS'),
  };
}
