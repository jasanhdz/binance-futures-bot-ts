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
        expect(rows[0]).toHaveProperty('shortBreakdownQuality');
        expect(rows[0]).toHaveProperty('shortSweepRisk');
        expect(rows[0]).toHaveProperty('shortContinuationScore');
        expect(rows[0]).toHaveProperty('shortRetestScore');
        expect(rows[0]).toHaveProperty('shortExtensionRisk');
        expect(rows[0]).toHaveProperty('shortAbsorptionRisk');
        expect(rows[0]).toHaveProperty('shortVolumePersistence');
        expect(rows[0]).toHaveProperty('shortAdverseReboundRisk');
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

    it('supports side-filtered dataset rows', () => {
        const rows = buildRegimeEngineV2MlDatasetRows(new Map<string, RegimeEngineV2InputCandle[]>([
            ['BTCUSDT', patternCandles('LONG', 170)],
            ['ETHUSDT', patternCandles('SHORT', 170)]
        ]), {
            symbols: ['BTCUSDT', 'ETHUSDT'],
            sampleEvery: 6,
            side: 'LONG'
        });

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.side === 'LONG')).toBe(true);
    });

    it('supports legacy XRP long pattern dataset rows', () => {
        const rows = buildRegimeEngineV2MlDatasetRows(new Map<string, RegimeEngineV2InputCandle[]>([
            ['XRPUSDT', legacyXrpLongCandles(180)]
        ]), {
            symbols: ['XRPUSDT'],
            sampleEvery: 3,
            legacyXrpLongPattern: true,
            source: 'legacy_xrp_long_window'
        });

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.side === 'LONG')).toBe(true);
        expect(rows.every((row) => row.source === 'legacy_xrp_long_window')).toBe(true);
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

function legacyXrpLongCandles(count: number): RegimeEngineV2InputCandle[] {
    const rows = patternCandles('LONG', count);
    for (let i = Math.max(80, count - 4); i < count; i++) {
        const previous = rows[i - 1];
        const open = previous.close;
        const close = open + 0.18;
        rows[i] = {
            timestamp: rows[i].timestamp,
            open,
            high: close + 0.04,
            low: open - 0.02,
            close,
            volume: 260
        };
    }
    return rows;
}
