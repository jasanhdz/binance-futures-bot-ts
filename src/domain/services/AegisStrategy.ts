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
  latency_ms?: number;
}

export interface AegisBlock {
  candidate?: string;
  candidate_status?: string;
  live_enabled?: boolean;
  prod?: AegisProdBlock;
  shadow?: AegisShadowBlock;
  turbo?: AegisTurboBlock;
  entry_quality_model?: AegisEntryQualityModelBlock;
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

export function isForbiddenTime(timestamp: number, forbiddenHours?: number[], forbiddenDays?: number[]): boolean {
  const date = new Date(timestamp);
  const hour = date.getUTCHours();
  const day = date.getUTCDay();
  return Boolean(forbiddenHours?.includes(hour) || forbiddenDays?.includes(day));
}
