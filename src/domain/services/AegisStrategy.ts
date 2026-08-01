export type AegisAction = 'LONG' | 'SHORT' | 'HOLD' | 'PASS' | 'CLOSE';

export interface AegisVotes {
  long?: number;
  short?: number;
  neutral?: number;
}

export interface AegisRecentScores {
  long_7d?: number;
  short_7d?: number;
  long_14d?: number;
  short_14d?: number;
  long_30d?: number;
  short_30d?: number;
  [key: string]: unknown;
}

export interface AegisTurboRaw {
  action?: AegisAction;
  would_execute?: boolean;
  reason?: string;
  turbo_score?: number;
  confidence?: string;
  leverage_suggestion?: number;
  position_fraction?: number;
  votes?: AegisVotes;
  vote_semantics?: 'SINGLE_DIRECTIONAL_ESTIMATOR_OUTPUT' | string;
  directional_member_count?: number;
  independent_directional_votes?: 'NOT_APPLICABLE' | string;
  directional_consensus?: 'NOT_APPLICABLE_SINGLE_ESTIMATOR' | string;
  recent_scores?: AegisRecentScores;
}

export interface AegisTurboGated {
  action?: AegisAction;
  would_execute?: boolean;
  reason?: string;
  blocked_by?: string | null;
}

export interface AegisTurboBlock {
  mode?: string;
  enabled?: boolean;
  execute?: boolean;
  live_enabled?: boolean;
  production_allowed?: boolean;
  action?: AegisAction;
  would_execute?: boolean;
  reason?: string;
  turbo_score?: number;
  confidence?: string;
  leverage_suggestion?: number;
  position_fraction?: number;
  stop_roe?: number;
  take_profit_roe?: number;
  trailing_activation_roe?: number;
  trailing_callback_roe?: number;
  raw?: AegisTurboRaw;
  gated?: AegisTurboGated;
  safe_context?: Record<string, unknown>;
  risk_guard?: Record<string, unknown>;
}

export interface AegisShadowBlock {
  enabled?: boolean;
  mode?: string;
  action?: AegisAction;
  would_execute?: boolean;
  execute?: boolean;
  reason?: string;
  size_mode?: string;
  position_fraction?: number;
  edge_score_h12?: number;
  tail_risk_score?: number;
  regime?: string;
  risk_tier?: string;
  not_live_reason?: string[];
}

export interface AegisProdBlock {
  allowed?: boolean;
  action?: AegisAction;
  execute?: boolean;
  reason?: string;
}

export interface AegisEntryQualityModelBlock {
  mode?: 'SHADOW' | string;
  execute?: boolean;
  production_allowed?: boolean;
  status?: string;
  symbol?: string;
  model_version?: string;
  model_scope?: 'symbol' | 'global' | 'none' | string;
  entry_quality_score?: number | null;
  tail_risk_score?: number | null;
  recommendation?: 'ALLOW_SHADOW' | 'BLOCK_SHADOW' | 'INSUFFICIENT_DATA' | 'MODEL_ERROR' | string;
  reason?: string;
  thresholds?: {
    quality_min?: number;
    tail_max?: number;
  };
  feature_status?: 'ok' | 'partial' | 'insufficient' | string;
  missing_features?: string[];
  feature_parity_pct?: number | null;
  missing_features_count?: number | null;
  approximated_features?: string[];
  critical_missing_groups?: string[];
  feature_build_latency_ms?: number | null;
  model_latency_ms?: number | null;
  total_latency_ms?: number | null;
  latency_ms?: number;
}

export interface AegisEntryQualityV2Block {
  schema_id?: 'aegis-entry-quality-v2-http-shadow-v1' | string;
  mode?: 'SHADOW' | 'LIVE' | 'UNAVAILABLE' | string;
  config_sha256?: string;
  status?: string;
  selected?: boolean;
  paper_action?: 'SHORT' | 'NO_TRADE' | string;
  score?: number;
  eligible?: boolean;
  opportunity_source?: string;
  regime?: Record<string, unknown>;
  exchange_authority?: boolean;
}

export interface AegisEventRiskAutoBlock {
  mode?: 'SHADOW' | string;
  suggested_mode?: 'NORMAL' | 'CAUTION' | 'RISK_OFF' | 'MANUAL_ONLY' | string;
  confidence?: number | null;
  reasons?: string[];
  btc_context?: Record<string, unknown>;
  eth_context?: Record<string, unknown>;
  market_context?: Record<string, unknown>;
  execute?: boolean;
  production_allowed?: boolean;
  does_not_change_event_risk_mode?: boolean;
  latency_ms?: number | null;
  last_update?: string | null;
  cache_status?: Record<string, unknown>;
}

export interface AegisDecisionBrainBlock {
  contract_version?: string;
  authority?: string;
  mode?: 'SHADOW' | string;
  execute?: boolean;
  selected?: boolean;
  production_allowed?: boolean;
  status?: string;
  model_version?: string;
  model_sha256?: string;
  bundle_sha256?: string;
  configuration_sha256?: string;
  feature_schema?: string;
  feature_count?: number;
  fallback?: boolean;
  symbol?: string;
  side?: 'LONG' | 'SHORT' | 'HOLD' | 'UNKNOWN' | string | null;
  decision?:
    | 'ENTER_NOW'
    | 'WAIT_CONFIRMATION'
    | 'MANUAL_ONLY'
    | 'DO_NOT_ENTER'
    | 'UNKNOWN'
    | string;
  enter_now_prob?: number | null;
  wait_confirmation_prob?: number | null;
  manual_only_prob?: number | null;
  do_not_enter_prob?: number | null;
  recommendation?: string;
  reason?: string;
  feature_status?: 'ok' | 'partial' | 'insufficient' | string;
  feature_parity_pct?: number | null;
  missing_features_count?: number | null;
  missing_features?: string[];
  critical_missing_groups?: string[];
  available_feature_groups?: string[];
  approximated_features?: string[];
  missing_features_by_group?: Record<string, string[]>;
  feature_group_coverage_pct?: Record<string, number>;
  feature_warnings?: string[];
  feature_build_latency_ms?: number | null;
  model_latency_ms?: number | null;
  total_latency_ms?: number | null;
  latency_ms?: number | null;
}

export interface AegisDirectionalEvidenceBlock {
  schema_id?: 'aegis-directional-evidence-v1' | string;
  semantics?: 'SINGLE_DIRECTIONAL_ESTIMATOR_OUTPUT' | string;
  eligible_directional_members?: number;
  independent_directional_votes?: 'NOT_APPLICABLE' | string;
  directional_consensus?: 'NOT_APPLICABLE_SINGLE_ESTIMATOR' | string;
  fabricated_votes?: number;
  selection_authority?: 'CANONICAL_PYTHON_SELECTED' | string;
}

export interface AegisBlock {
  candidate?: string;
  candidate_status?: string;
  live_enabled?: boolean;
  prod?: AegisProdBlock;
  shadow?: AegisShadowBlock;
  turbo?: AegisTurboBlock;
  entry_quality_model?: AegisEntryQualityModelBlock;
  entry_quality_v2?: AegisEntryQualityV2Block;
  event_risk_auto?: AegisEventRiskAutoBlock;
  decision_brain?: AegisDecisionBrainBlock;
  directional_evidence?: AegisDirectionalEvidenceBlock;
  clean_entry_guard?: Record<string, unknown>;
}

export interface AegisPredictionResponse {
  symbol?: string;
  long_prob?: number;
  short_prob?: number;
  neutral_prob?: number;
  close_prob?: number;
  smart_leverage?: number;
  meta_verdict?: string;
  features?: Record<string, any>;
  aegis?: AegisBlock;
  [key: string]: any;
}

export interface AegisTradingSignal {
  symbol: string;
  action: 'LONG' | 'SHORT' | 'PASS';
  confidence: number;
  source: 'AEGIS_SAFE' | 'AEGIS_TURBO';
  longProb: number;
  shortProb: number;
  neutralProb: number;
  closeProb?: number;
  smart_leverage?: number;
  features?: Record<string, any>;
  aegis?: AegisBlock;
  metadata?: {
    aegis?: AegisBlock;
    meta_verdict?: string;
    rawPrediction?: AegisPredictionResponse;
    [key: string]: unknown;
  };
}

export function isForbiddenTime(
  timestamp: number,
  forbiddenHours?: number[],
  forbiddenDays?: number[],
): boolean {
  const date = new Date(timestamp);
  const hour = date.getUTCHours();
  const day = date.getUTCDay();
  return Boolean(forbiddenHours?.includes(hour) || forbiddenDays?.includes(day));
}
