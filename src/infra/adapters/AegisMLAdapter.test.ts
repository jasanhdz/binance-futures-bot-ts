import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config/environment';
import { AegisMLServiceClient } from './AegisMLAdapter';

vi.mock('axios', () => ({
  default: {
    create: vi.fn(),
  },
}));

describe('AegisMLServiceClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('preserves entry_quality_model when present', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        symbol: 'ETHUSDT',
        long_prob: 0.1,
        short_prob: 0.2,
        neutral_prob: 0.7,
        aegis: {
          entry_quality_model: {
            mode: 'SHADOW',
            execute: false,
            production_allowed: false,
            entry_quality_score: 0.64,
            tail_risk_score: 0.37,
            recommendation: 'ALLOW_SHADOW',
          },
        },
      },
    });
    vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn() } as any);

    const client = new AegisMLServiceClient();
    const response = await client.fetchPrediction({ symbol: 'ETHUSDT' });

    expect(post).toHaveBeenCalledWith(
      '/ml-v2/predict',
      { symbol: 'ETHUSDT' },
      { timeout: CONFIG.ML_PREDICT_TIMEOUT_MS },
    );
    expect(response.aegis?.entry_quality_model?.mode).toBe('SHADOW');
    expect(response.aegis?.entry_quality_model?.execute).toBe(false);
  });

  it('preserves entry_quality_v2 as non-authoritative Shadow evidence', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        symbol: 'ETHUSDT',
        long_prob: 0,
        short_prob: 1,
        neutral_prob: 0,
        aegis: {
          entry_quality_v2: {
            schema_id: 'aegis-entry-quality-v2-http-shadow-v1',
            mode: 'SHADOW',
            selected: true,
            paper_action: 'SHORT',
            score: 0.004,
            exchange_authority: false,
          },
          prod: {
            allowed: false,
            action: 'HOLD',
            execute: false,
          },
        },
      },
    });
    vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn() } as any);

    const client = new AegisMLServiceClient();
    const response = await client.fetchPrediction({ symbol: 'ETHUSDT' });

    expect(response.aegis?.entry_quality_v2?.mode).toBe('SHADOW');
    expect(response.aegis?.entry_quality_v2?.selected).toBe(true);
    expect(response.aegis?.entry_quality_v2?.exchange_authority).toBe(false);
    expect(response.aegis?.prod?.execute).toBe(false);
  });

  it('handles missing entry_quality_model', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        symbol: 'ETHUSDT',
        long_prob: 0.1,
        short_prob: 0.2,
        neutral_prob: 0.7,
        aegis: { turbo: { action: 'HOLD' } },
      },
    });
    vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn() } as any);

    const client = new AegisMLServiceClient();
    const response = await client.fetchPrediction({ symbol: 'ETHUSDT' });

    expect(response.aegis?.entry_quality_model).toBeUndefined();
    expect(response.aegis?.turbo?.action).toBe('HOLD');
  });

  it('preserves event_risk_auto when present', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        symbol: 'ETHUSDT',
        long_prob: 0.1,
        short_prob: 0.2,
        neutral_prob: 0.7,
        aegis: {
          event_risk_auto: {
            mode: 'SHADOW',
            suggested_mode: 'CAUTION',
            confidence: 0.72,
            reasons: ['btc_weak_or_hold'],
            execute: false,
            production_allowed: false,
            does_not_change_event_risk_mode: true,
          },
        },
      },
    });
    vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn() } as any);

    const client = new AegisMLServiceClient();
    const response = await client.fetchPrediction({ symbol: 'ETHUSDT' });

    expect(response.aegis?.event_risk_auto?.mode).toBe('SHADOW');
    expect(response.aegis?.event_risk_auto?.suggested_mode).toBe('CAUTION');
    expect(response.aegis?.event_risk_auto?.execute).toBe(false);
    expect(response.aegis?.event_risk_auto?.does_not_change_event_risk_mode).toBe(true);
  });

  it('preserves decision_brain when present', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        symbol: 'ETHUSDT',
        long_prob: 0.1,
        short_prob: 0.2,
        neutral_prob: 0.7,
        aegis: {
          decision_brain: {
            mode: 'SHADOW',
            status: 'RESEARCH_CANDIDATE_NOT_LIVE',
            model_version: 'v010',
            decision: 'DO_NOT_ENTER',
            enter_now_prob: 0.18,
            wait_confirmation_prob: 0.22,
            manual_only_prob: 0.08,
            do_not_enter_prob: 0.52,
            recommendation: 'DO_NOT_ENTER_SHADOW',
            execute: false,
            production_allowed: false,
          },
        },
      },
    });
    vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn() } as any);

    const client = new AegisMLServiceClient();
    const response = await client.fetchPrediction({ symbol: 'ETHUSDT' });

    expect(response.aegis?.decision_brain?.mode).toBe('SHADOW');
    expect(response.aegis?.decision_brain?.decision).toBe('DO_NOT_ENTER');
    expect(response.aegis?.decision_brain?.execute).toBe(false);
    expect(response.aegis?.decision_brain?.production_allowed).toBe(false);
  });

  it('returns defensive HOLD prediction when predict times out', async () => {
    const post = vi.fn().mockRejectedValue(new Error('timeout of 5000ms exceeded'));
    vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn() } as any);

    const client = new AegisMLServiceClient();
    const response = await client.fetchPrediction({ symbol: 'LINKUSDT' });

    expect(response.symbol).toBe('LINKUSDT');
    expect(response.meta_verdict).toBe('AEGIS_ML_FALLBACK_HOLD');
    expect(response.neutral_prob).toBe(1);
    expect(response.aegis?.turbo?.raw?.would_execute).toBe(false);
    expect(response.aegis?.turbo?.gated?.blocked_by).toBe('ml_client_fallback');
    expect(response.aegis?.decision_brain?.decision).toBe('DO_NOT_ENTER');
    expect(response.metadata?.fallback).toBe(true);
  });

  it('uses bounded route-specific timeouts', async () => {
    const post = vi.fn().mockResolvedValue({ data: { action: 'HOLD', confidence: 0.5 } });
    const get = vi.fn().mockResolvedValue({ status: 200 });
    vi.mocked(axios.create).mockReturnValue({ post, get } as any);

    const client = new AegisMLServiceClient();
    await client.getExitSignal({ symbol: 'ETHUSDT' });
    await client.checkHealth();

    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: CONFIG.ML_PREDICT_TIMEOUT_MS }),
    );
    expect(post).toHaveBeenCalledWith(
      '/ml-v2/exit_signal',
      { symbol: 'ETHUSDT' },
      { timeout: CONFIG.ML_EXIT_SIGNAL_TIMEOUT_MS },
    );
    expect(get).toHaveBeenCalledWith('/health', { timeout: CONFIG.ML_HEALTH_TIMEOUT_MS });
  });
});
