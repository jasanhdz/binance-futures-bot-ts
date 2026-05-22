import { describe, expect, it } from 'vitest';
import { RegimeEngineV2InputCandle } from '../domain/services/regime-v2/RegimeEngineV2.types';
import { buildRegimeEngineV2MlDatasetRows } from './regimeEngineV2MlDatasetCore';

describe('regimeEngineV2MlDatasetCore', () => {
    it('exports expected columns for momentum pattern samples', () => {
        const rows = buildRegimeEngineV2MlDatasetRows(new Map<string, RegimeEngineV2InputCandle[]>([
            ['BTCUSDT', patternCandles('LONG', 190)],
            ['ETHUSDT', patternCandles('SHORT', 190)]
        ]), {
            symbols: ['BTCUSDT', 'ETHUSDT'],
            sampleEvery: 12,
            feeBps: 8,
            slippageBps: 3
        });

        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]).toHaveProperty('target_hit8_before_minus5');
        expect(rows[0]).toHaveProperty('breakoutCloseBeyondRangePct');
        expect(rows[0]).toHaveProperty('failedBreakoutPressure');
        expect(rows[0]).toHaveProperty('patternKind');
    });

    it('keeps future targets out of feature-like columns', () => {
        const rows = buildRegimeEngineV2MlDatasetRows(new Map<string, RegimeEngineV2InputCandle[]>([
            ['BTCUSDT', patternCandles('LONG', 160)]
        ]), {
            symbols: ['BTCUSDT'],
            sampleEvery: 6
        });

        const featureKeys = Object.keys(rows[0]).filter((key) => !key.startsWith('target_'));
        expect(featureKeys).not.toContain('target_hit8_before_minus5');
        expect(rows[0].target_mfe_roe_60m).not.toBeUndefined();
    });

    it('separates side correctly', () => {
        const rows = buildRegimeEngineV2MlDatasetRows(new Map<string, RegimeEngineV2InputCandle[]>([
            ['BTCUSDT', patternCandles('LONG', 170)],
            ['ETHUSDT', patternCandles('SHORT', 170)]
        ]), {
            symbols: ['BTCUSDT', 'ETHUSDT'],
            sampleEvery: 6
        });

        expect(rows.some((row) => row.side === 'LONG')).toBe(true);
        expect(rows.some((row) => row.side === 'SHORT')).toBe(true);
    });
});

function patternCandles(side: 'LONG' | 'SHORT', count: number): RegimeEngineV2InputCandle[] {
    const rows: RegimeEngineV2InputCandle[] = [];
    let price = 100;
    for (let index = 0; index < count; index++) {
        const drift = side === 'LONG' ? 0.04 : -0.04;
        const impulse = index > count - 20 ? (side === 'LONG' ? 0.22 : -0.22) : 0;
        const open = price;
        const close = price + drift + impulse;
        rows.push({
            timestamp: Date.parse('2026-05-01T00:00:00.000Z') + index * 5 * 60_000,
            open,
            high: Math.max(open, close) + 0.04,
            low: Math.min(open, close) - 0.04,
            close,
            volume: 100 + (index > count - 20 ? 180 : 0)
        });
        price = close;
    }
    return rows;
}
