import axios, { AxiosInstance } from 'axios';
import { MLService } from '../../app/ports/MLService';
import { AegisPredictionResponse } from '../../domain/services/AegisStrategy';
import { CONFIG } from '../config/environment';

export class AegisMLServiceClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: CONFIG.ML_SERVICE_URL.replace(/\/+$/, ''),
      timeout: CONFIG.ML_PREDICT_TIMEOUT_MS,
    });
  }

  async fetchPrediction(payload: { symbol: string }): Promise<AegisPredictionResponse> {
    try {
      const { data } = await this.http.post<AegisPredictionResponse>(
        '/ml-v2/predict',
        { symbol: payload.symbol },
        { timeout: CONFIG.ML_PREDICT_TIMEOUT_MS },
      );
      return data;
    } catch (error) {
      return buildDefensivePrediction(payload.symbol, error);
    }
  }

  async getExitSignal(payload: any): ReturnType<MLService['getExitSignal']> {
    try {
      const { data } = await this.http.post<{ action: string; confidence: number }>(
        '/ml-v2/exit_signal',
        payload,
        { timeout: CONFIG.ML_EXIT_SIGNAL_TIMEOUT_MS },
      );
      return {
        action: data.action,
        confidence: data.confidence,
      };
    } catch {
      return { action: 'HOLD', confidence: 0 };
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await this.http.get('/health', { timeout: CONFIG.ML_HEALTH_TIMEOUT_MS });
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

function buildDefensivePrediction(symbol: string, error: unknown): AegisPredictionResponse {
  const reason = 'ml_predict_unavailable';
  return {
    symbol,
    long_prob: 0,
    short_prob: 0,
    neutral_prob: 1,
    close_prob: 0,
    smart_leverage: 0,
    meta_verdict: 'AEGIS_ML_FALLBACK_HOLD',
    features: {
      fallback: true,
      fallback_reason: reason,
    },
    aegis: {
      candidate: 'ml_client_fallback',
      candidate_status: 'NOT_LOADED',
      live_enabled: false,
      prod: {
        allowed: false,
        action: 'HOLD',
        execute: false,
        reason,
      },
      shadow: {
        enabled: false,
        mode: 'SHADOW_ONLY',
        action: 'HOLD',
        would_execute: false,
        execute: false,
        reason,
      },
      turbo: {
        enabled: false,
        execute: false,
        live_enabled: false,
        production_allowed: false,
        action: 'HOLD',
        would_execute: false,
        reason,
        turbo_score: 0,
        confidence: 'blocked',
        leverage_suggestion: 0,
        position_fraction: 0,
        raw: {
          action: 'HOLD',
          would_execute: false,
          reason,
          turbo_score: 0,
          confidence: 'blocked',
          leverage_suggestion: 0,
          position_fraction: 0,
          votes: { long: 0, short: 0, neutral: 0 },
          recent_scores: {
            long_7d: undefined,
            short_7d: undefined,
            long_14d: undefined,
            short_14d: undefined,
            long_30d: undefined,
            short_30d: undefined,
          },
        },
        gated: {
          action: 'HOLD',
          would_execute: false,
          reason,
          blocked_by: 'ml_client_fallback',
        },
        safe_context: {
          safe_action: 'HOLD',
          safe_reason: reason,
        },
        risk_guard: {
          blocked: true,
          reason,
        },
      },
      entry_quality_model: {
        mode: 'SHADOW',
        execute: false,
        production_allowed: false,
        status: 'RESEARCH_CANDIDATE_NOT_LIVE',
        symbol,
        model_version: 'v020',
        entry_quality_score: null,
        tail_risk_score: null,
        recommendation: 'MODEL_ERROR',
        reason,
        feature_status: 'insufficient',
        feature_parity_pct: 0,
        missing_features_count: 0,
        missing_features: [],
        model_scope: 'none',
        latency_ms: 0,
      },
      event_risk_auto: {
        mode: 'SHADOW',
        suggested_mode: 'RISK_OFF',
        confidence: 1,
        reasons: [reason],
        execute: false,
        production_allowed: false,
        does_not_change_event_risk_mode: true,
      },
      decision_brain: {
        mode: 'SHADOW',
        execute: false,
        production_allowed: false,
        status: 'RESEARCH_CANDIDATE_NOT_LIVE',
        model_version: 'v010',
        symbol,
        side: 'UNKNOWN',
        decision: 'DO_NOT_ENTER',
        enter_now_prob: 0,
        wait_confirmation_prob: 0,
        manual_only_prob: 0,
        do_not_enter_prob: 1,
        recommendation: 'MODEL_ERROR',
        reason,
        feature_status: 'insufficient',
        missing_features_count: 0,
        missing_features: [],
        critical_missing_groups: [],
        latency_ms: 0,
      },
      e4_tail_risk: {
        available: false,
        score: null,
        threshold: 0.4522452210875323,
        decision: 'BLOCK',
        reason: 'ml_client_fallback',
        model_version: 'E4_V1_FROZEN',
        feature_snapshot_hash: '',
        feature_available_at: null,
        source_feed_lag_ms: null,
        computed_at: null,
        cache_age_ms: null
      },
    },
    metadata: {
      fallback: true,
      fallback_reason: reason,
      error: String(error),
    },
  };
}
