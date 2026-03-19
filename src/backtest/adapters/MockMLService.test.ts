import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockMLService } from './MockMLService';
import { MockExchange } from './MockExchange';
import axios from 'axios';

// Mock Axios
vi.mock('axios');

describe('MockMLService', () => {
    let mlService: MockMLService;
    let exchange: MockExchange;

    beforeEach(() => {
        exchange = new MockExchange();
        mlService = new MockMLService(exchange);
        vi.clearAllMocks();
    });

    it('should return SHORT signal when API returns action 1', async () => {
        // Mock Exchange to return a candle
        exchange.setCandle({
            timestamp: 1000,
            open: 100, high: 110, low: 90, close: 100, volume: 1000, buyVolume: 0,
            openTime: 1000, closeTime: 1300
        }, null);

        // Mock API Response
        (axios.post as any).mockResolvedValue({
            data: {
                action: 1, // SHORT
                confidence: 0.85,
                features: { cvd_slope: -5, cvd_z: 2.0, weakness: 0.9 }
            }
        });

        const signal = await mlService.getSignal('ETHUSDT');

        expect(signal.action).toBe('SHORT');
        expect(signal.confidence).toBe(0.85);
        expect(signal.features?.cvd_slope).toBe(-5);
    });

    it('should return PASS signal when API returns action 0', async () => {
        exchange.setCandle({
            timestamp: 1000,
            open: 100, high: 110, low: 90, close: 100, volume: 1000, buyVolume: 0,
            openTime: 1000, closeTime: 1300
        }, null);

        (axios.post as any).mockResolvedValue({
            data: {
                action: 0,
                confidence: 0.2,
                features: {}
            }
        });

        const signal = await mlService.getSignal('ETHUSDT');

        expect(signal.action).toBe('PASS');
        expect(signal.confidence).toBe(0.2);
    });

    it('should handle API errors gracefully (return PASS)', async () => {
        exchange.setCandle({
            timestamp: 1000,
            open: 100, high: 110, low: 90, close: 100, volume: 1000, buyVolume: 0,
            openTime: 1000, closeTime: 1300
        }, null);

        (axios.post as any).mockRejectedValue(new Error('Network Error'));

        const signal = await mlService.getSignal('ETHUSDT');

        expect(signal.action).toBe('PASS');
        expect(signal.confidence).toBe(0);
    });
});
