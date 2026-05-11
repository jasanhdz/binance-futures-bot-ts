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
});
