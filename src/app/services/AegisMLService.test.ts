import { describe, expect, it, vi } from 'vitest';
import { AegisMLService } from './AegisMLService';
import { AegisPredictionResponse } from '../../domain/services/AegisStrategy';

describe('AegisMLService', () => {
    it('returns a PASS Aegis signal and preserves Aegis metadata', async () => {
        const prediction: AegisPredictionResponse = {
            symbol: 'ETHUSDT',
            long_prob: 0.72,
            short_prob: 0.12,
            neutral_prob: 0.16,
            close_prob: 0.03,
            smart_leverage: 0,
            meta_verdict: 'shadow_only',
            features: { cvd_z: 1.2 },
            aegis: {
                shadow: {
                    action: 'LONG',
                    would_execute: true,
                    execute: false,
                    reason: 'shadow_observation'
                },
                entry_quality_model: {
                    mode: 'SHADOW',
                    execute: false,
                    production_allowed: false,
                    status: 'RESEARCH_CANDIDATE_NOT_LIVE',
                    symbol: 'ETHUSDT',
                    model_version: 'v020',
                    model_scope: 'symbol',
                    entry_quality_score: 0.64,
                    tail_risk_score: 0.37,
                    recommendation: 'ALLOW_SHADOW',
                    reason: 'quality_above_threshold_tail_ok',
                    feature_status: 'partial',
                    missing_features: ['ema_9'],
                    latency_ms: 4.2
                },
                turbo: {
                    raw: {
                        action: 'LONG',
                        turbo_score: 0.91,
                        would_execute: true
                    },
                    gated: {
                        action: 'PASS',
                        reason: 'live_disabled',
                        blocked_by: 'AEGIS_LIVE_ENABLED'
                    }
                }
            }
        };
        const client = {
            fetchPrediction: vi.fn().mockResolvedValue(prediction),
            getExitSignal: vi.fn(),
            checkHealth: vi.fn()
        };

        const service = new AegisMLService(client as any);
        const signal = await service.getSignal('ETHUSDT');

        expect(client.fetchPrediction).toHaveBeenCalledWith({ symbol: 'ETHUSDT' });
        expect(signal.action).toBe('PASS');
        expect(signal.confidence).toBe(0);
        expect(signal.source).toBe('AEGIS_SAFE');
        expect(signal.longProb).toBe(0.72);
        expect(signal.smart_leverage).toBe(0);
        expect(signal.metadata?.aegis).toBe(prediction.aegis);
        expect(signal.metadata?.aegis?.entry_quality_model).toBe(prediction.aegis?.entry_quality_model);
        expect(signal.metadata?.aegis?.entry_quality_model?.execute).toBe(false);
        expect(signal.metadata?.rawPrediction).toBe(prediction);
    });
});
