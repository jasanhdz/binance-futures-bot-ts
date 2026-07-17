/** Versioned scientific contract shared with the Python brain. */

export const BRAIN_CONTRACT_VERSION = 'aegis-clean-rebuild-v1' as const;

export type BrainContractVersion = typeof BRAIN_CONTRACT_VERSION;
export type ScientificSide = 'LONG' | 'SHORT' | 'NO_TRADE';
export type DecisionStatus = 'SELECTED' | 'NO_TRADE' | 'ERROR';

export interface Candle {
  open_time: string;
  close_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  is_closed: boolean;
  source: string;
  sequence?: string;
}

export interface SymbolSeries {
  symbol: string;
  candles: readonly Candle[];
  last_confirmed_close: string;
  feed_quality: Readonly<Record<string, string | number | boolean>>;
}

export interface PortfolioContext {
  blocked_symbols: readonly string[];
  occupied_symbols: readonly string[];
  available_slots: number;
  long_exposure_count: number;
  short_exposure_count: number;
  active_cooldowns: Readonly<Record<string, string>>;
  accepted_decision_ids: readonly string[];
  operational_time: string;
}

export interface MarketSnapshot {
  closed_at: string;
  timeframe: string;
  symbol_set_hash: string;
  series: readonly SymbolSeries[];
  portfolio: PortfolioContext;
}

export interface DecisionRequest {
  request_id: string;
  decision_cycle_id: string;
  schema_version: string;
  contract_version: BrainContractVersion;
  config_version: string;
  snapshot: MarketSnapshot;
}

export interface RiskIntent {
  stop_distance_fraction?: number;
  volatility_multiple?: number;
  target_risk_ratio?: number;
  maximum_holding_bars?: number;
  scientific_invalidation?: string;
  relative_priority?: number;
}

export interface Candidate {
  candidate_id: string;
  symbol: string;
  side: ScientificSide;
  raw_score: number;
  calibrated_score: number;
  confidence: number;
  uncertainty: number;
  regime: string;
  compatibility: number;
  expected_return?: number;
  horizon: string;
  risk_intent: RiskIntent;
  positive_reasons: readonly string[];
  rejection_reasons: readonly string[];
  candidate_hash: string;
}

export interface DecisionResponse {
  contract_version: BrainContractVersion;
  decision_id: string;
  decision_cycle_id: string;
  generated_at: string;
  expires_at: string;
  status: DecisionStatus;
  universe_id: string;
  symbol_set_hash: string;
  config_version: string;
  model_bundle_id: string;
  feature_schema_version: string;
  evidence_hash: string;
  selected: readonly Candidate[];
  ranking_summary: readonly string[];
  warnings: readonly string[];
}

export interface BrainManifest {
  contract_version: BrainContractVersion;
  universe_id: string;
  symbols: readonly string[];
  symbol_set_hash: string;
  timeframe: string;
  config_version: string;
  model_bundle_id: string;
  feature_schema_version: string;
  capabilities: readonly string[];
  build_id: string;
  ready: boolean;
}

export interface DecisionOutcome {
  decision_id: string;
  decision_cycle_id: string;
  candidate_hash?: string;
  accepted: boolean;
  executed: boolean;
  reason_codes: readonly string[];
  occurred_at: string;
  normalized_details: Readonly<Record<string, string | number | boolean | null>>;
}
