import { describe, expect, it } from 'vitest';
import { RegimeEngineV2 } from './RegimeEngineV2';
import { RegimeEngineV2InputCandle } from './RegimeEngineV2.types';

describe('RegimeEngineV2', () => {
    it('returns UNKNOWN when there is not enough history', () => {
        const result = RegimeEngineV2.evaluate({
            symbol: 'ETHUSDT',
            candles: candlesFromCloses([100, 101, 102])
        });

        expect(result.technicalRegime).toBe('UNKNOWN');
        expect(result.momentumEnvironment).toBe('UNKNOWN');
    });

    it('classifies CHOP with low movement mixed structure', () => {
        const candles = Array.from({ length: 140 }, (_, index) => {
            const base = 100 + Math.sin(index / 2) * 0.12;
            return candle(index, base - 0.02, base + 0.08, base - 0.08, base + 0.02, 100);
        });

        const result = RegimeEngineV2.evaluate({ symbol: 'ETHUSDT', candles });

        expect(['CHOP', 'ACCUMULATION_RANGE']).toContain(result.technicalRegime);
        expect(result.momentumEnvironment).toBe('AVOID_MOMENTUM');
    });

    it('classifies BREAKOUT_UP_EARLY with range break and volume', () => {
        const candles = [
            ...Array.from({ length: 130 }, (_, index) => candle(index, 100, 100.4, 99.6, 100 + Math.sin(index) * 0.1, 100)),
            candle(130, 100.05, 100.35, 99.95, 100.2, 155),
            candle(131, 100.1, 100.38, 99.95, 100.25, 160),
            candle(132, 100.15, 100.39, 99.95, 100.3, 165),
            candle(133, 100.2, 102.4, 100.1, 102.2, 260)
        ];

        const result = RegimeEngineV2.evaluate({
            symbol: 'ETHUSDT',
            candles,
            market: { btc: { action: 'LONG', score: 0.8 }, eth: { action: 'LONG', score: 0.8 } }
        });

        expect(result.technicalRegime).toBe('BREAKOUT_UP_EARLY');
        expect(result.momentumEnvironment).toBe('ALLOW_LONG_MOMENTUM');
        expect(result.reasons).toContain('breakout_v22_confirmed');
        expect(result.indicators.breakoutCloseBeyondRangePct).toBeGreaterThan(0);
    });

    it('degrades breakout up when adverse wick is high', () => {
        const candles = [
            ...Array.from({ length: 132 }, (_, index) => candle(index, 100, 100.4, 99.7, 100 + Math.sin(index) * 0.08, 100)),
            candle(132, 100.05, 100.35, 99.95, 100.2, 160),
            candle(133, 100.1, 100.38, 99.95, 100.25, 165),
            candle(134, 100.2, 102.2, 96.8, 101.6, 260)
        ];

        const result = RegimeEngineV2.evaluate({ symbol: 'ETHUSDT', candles });

        expect(result.technicalRegime).not.toBe('BREAKOUT_UP_EARLY');
        expect(result.reasons).toContain('breakout_adverse_wick_high');
        expect(['WATCH_LONG_MOMENTUM', 'AVOID_MOMENTUM']).toContain(result.momentumEnvironment);
    });

    it('degrades breakout up when close is not far enough outside range', () => {
        const candles = [
            ...Array.from({ length: 132 }, (_, index) => candle(index, 100, 100.4, 99.7, 100 + Math.sin(index) * 0.08, 100)),
            candle(132, 100.05, 100.35, 99.95, 100.2, 160),
            candle(133, 100.1, 100.38, 99.95, 100.25, 165),
            candle(134, 100.3, 100.8, 99.6, 100.5, 260)
        ];

        const result = RegimeEngineV2.evaluate({ symbol: 'ETHUSDT', candles });

        expect(result.technicalRegime).not.toBe('BREAKOUT_UP_EARLY');
        expect(result.reasons).toContain('breakout_close_not_far_enough');
    });

    it('degrades breakout down when adverse wick is high', () => {
        const candles = [
            ...Array.from({ length: 132 }, (_, index) => candle(index, 100, 100.3, 99.6, 100 + Math.sin(index) * 0.08, 100)),
            candle(132, 99.95, 100.2, 99.6, 99.8, 160),
            candle(133, 99.9, 100.2, 99.62, 99.75, 165),
            candle(134, 99.8, 103.2, 97.8, 98.4, 260)
        ];

        const result = RegimeEngineV2.evaluate({ symbol: 'ETHUSDT', candles });

        expect(result.technicalRegime).not.toBe('BREAKOUT_DOWN_EARLY');
        expect(result.reasons).toContain('breakout_adverse_wick_high');
        expect(['WATCH_SHORT_MOMENTUM', 'AVOID_MOMENTUM']).toContain(result.momentumEnvironment);
    });

    it('degrades breakout down when volume persistence is low', () => {
        const candles = [
            ...Array.from({ length: 132 }, (_, index) => candle(index, 100, 100.3, 99.6, 100 + Math.sin(index) * 0.08, 100)),
            candle(132, 99.95, 100.2, 99.6, 99.8, 70),
            candle(133, 99.9, 100.2, 99.62, 99.75, 70),
            candle(134, 99.6, 99.7, 97.9, 98.2, 126)
        ];

        const result = RegimeEngineV2.evaluate({ symbol: 'ETHUSDT', candles });

        expect(result.technicalRegime).not.toBe('BREAKOUT_DOWN_EARLY');
        expect(result.reasons).toContain('breakout_volume_not_persistent');
    });

    it('classifies MOMENTUM_UP_EARLY without overextension', () => {
        const candles = [
            ...Array.from({ length: 112 }, (_, index) => candle(index, 100, 100.25, 99.75, 100 + Math.sin(index / 3) * 0.05, 100)),
            ...trendingCandles('UP', 38, { step: 0.08, volume: 135, startIndex: 112, startPrice: 100 })
        ];

        const result = RegimeEngineV2.evaluate({
            symbol: 'ETHUSDT',
            candles,
            market: { btc: { action: 'LONG' }, eth: { action: 'LONG' } }
        });

        expect(['MOMENTUM_UP_EARLY', 'BREAKOUT_UP_EARLY']).toContain(result.technicalRegime);
        expect(result.momentumEnvironment).toBe('ALLOW_LONG_MOMENTUM');
    });

    it('classifies MOMENTUM_UP_EXHAUSTED with extension wick and fading volume', () => {
        const candles = [
            ...trendingCandles('UP', 145, { step: 0.13, volume: 180 }),
            candle(145, 119, 124, 118.8, 120.1, 80),
            candle(146, 120.1, 125.2, 119.9, 120.4, 70),
            candle(147, 120.4, 126, 120.2, 120.7, 65),
            candle(148, 120.7, 127, 120.5, 121, 60),
            candle(149, 121, 128.5, 120.8, 121.2, 55)
        ];

        const result = RegimeEngineV2.evaluate({ symbol: 'ETHUSDT', candles });

        expect(result.technicalRegime).toBe('MOMENTUM_UP_EXHAUSTED');
        expect(result.transition.risk).toBe('HIGH');
        expect(['WATCH_LONG_MOMENTUM', 'AVOID_MOMENTUM']).toContain(result.momentumEnvironment);
    });

    it('raises transition risk with ADX deceleration overextension and wicks', () => {
        const candles = [
            ...trendingCandles('UP', 145, { step: 0.16, volume: 190 }),
            candle(145, 123, 130, 122.5, 125.4, 70),
            candle(146, 125.4, 132, 125.1, 126.2, 60),
            candle(147, 126.2, 133, 125.8, 126.6, 55),
            candle(148, 126.6, 134, 126.1, 126.9, 50),
            candle(149, 126.9, 135, 126.3, 127.1, 45)
        ];

        const result = RegimeEngineV2.evaluate({ symbol: 'ETHUSDT', candles });

        expect(result.scores.transitionRisk).toBeGreaterThan(0.7);
        expect(result.transition.reasons).toContain('extended_from_ema25');
    });

    it('degrades ALLOW to WATCH when market confirmation contradicts', () => {
        const candles = trendingCandles('UP', 150, { step: 0.08, volume: 130 });

        const result = RegimeEngineV2.evaluate({
            symbol: 'ETHUSDT',
            candles,
            market: { btc: { action: 'SHORT', score: 0.9 }, eth: { action: 'SHORT', score: 0.8 } }
        });

        expect(result.marketConfirmation.state).toBe('CONTRADICT');
        expect(result.momentumEnvironment).toBe('WATCH_LONG_MOMENTUM');
    });
});

function trendingCandles(direction: 'UP' | 'DOWN', count: number, options: { step: number; volume: number; startIndex?: number; startPrice?: number }): RegimeEngineV2InputCandle[] {
    const rows: RegimeEngineV2InputCandle[] = [];
    let price = options.startPrice ?? 100;
    for (let index = 0; index < count; index++) {
        const candleIndex = (options.startIndex ?? 0) + index;
        const drift = direction === 'UP' ? options.step : -options.step;
        const open = price;
        const close = price + drift + Math.sin(index / 5) * options.step * 0.2;
        const high = Math.max(open, close) + options.step * 0.55;
        const low = Math.min(open, close) - options.step * 0.35;
        rows.push(candle(candleIndex, open, high, low, close, options.volume + (index % 8) * 3));
        price = close;
    }
    return rows;
}

function candlesFromCloses(closes: number[]): RegimeEngineV2InputCandle[] {
    return closes.map((close, index) => candle(index, close, close + 0.2, close - 0.2, close, 100));
}

function candle(index: number, open: number, high: number, low: number, close: number, volume: number): RegimeEngineV2InputCandle {
    return {
        timestamp: Date.parse('2026-05-01T00:00:00.000Z') + index * 5 * 60_000,
        open,
        high,
        low,
        close,
        volume
    };
}
