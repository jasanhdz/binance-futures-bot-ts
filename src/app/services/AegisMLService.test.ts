import { describe, expect, it, vi } from 'vitest';
import { AegisMLService } from './AegisMLService';
import { AegisPredictionResponse } from '../../domain/services/AegisStrategy';
import { CONFIG } from '../../infra/config/environment';

describe('AegisMLService', () => {
    it('returns a PASS Phantom-compatible signal in AEGIS_SHADOW and preserves Aegis metadata', async () => {
        (CONFIG as any).TRADING_MODE = 'AEGIS_SHADOW';
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
        expect(signal.longProb).toBe(0.72);
        expect(signal.smart_leverage).toBe(0);
        expect(signal.metadata?.aegis).toBe(prediction.aegis);
        expect(signal.metadata?.rawPrediction).toBe(prediction);
    });
});
