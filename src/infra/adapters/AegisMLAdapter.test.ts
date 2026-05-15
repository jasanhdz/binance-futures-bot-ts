import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { AegisMLServiceClient } from './AegisMLAdapter';

vi.mock('axios', () => ({
    default: {
        create: vi.fn()
    }
}));

describe('AegisMLServiceClient', () => {
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
                        recommendation: 'ALLOW_SHADOW'
                    }
                }
            }
        });
        vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn() } as any);

        const client = new AegisMLServiceClient();
        const response = await client.fetchPrediction({ symbol: 'ETHUSDT' });

        expect(post).toHaveBeenCalledWith('/ml-v2/predict', { symbol: 'ETHUSDT' });
        expect(response.aegis?.entry_quality_model?.mode).toBe('SHADOW');
        expect(response.aegis?.entry_quality_model?.execute).toBe(false);
    });

    it('handles missing entry_quality_model', async () => {
        const post = vi.fn().mockResolvedValue({
            data: {
                symbol: 'ETHUSDT',
                long_prob: 0.1,
                short_prob: 0.2,
                neutral_prob: 0.7,
                aegis: { turbo: { action: 'HOLD' } }
            }
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
                        does_not_change_event_risk_mode: true
                    }
                }
            }
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
                        production_allowed: false
                    }
                }
            }
        });
        vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn() } as any);

        const client = new AegisMLServiceClient();
        const response = await client.fetchPrediction({ symbol: 'ETHUSDT' });

        expect(response.aegis?.decision_brain?.mode).toBe('SHADOW');
        expect(response.aegis?.decision_brain?.decision).toBe('DO_NOT_ENTER');
        expect(response.aegis?.decision_brain?.execute).toBe(false);
        expect(response.aegis?.decision_brain?.production_allowed).toBe(false);
    });
});
