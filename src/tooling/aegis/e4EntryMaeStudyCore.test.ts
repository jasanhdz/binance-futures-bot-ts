import { describe, expect, it } from 'vitest';
import { analyzeTradePath, RoeObservation, simulateDelayedEntry, simulateProtection, TradePathStudyInput } from './e4EntryMaeStudyCore';

function input(overrides: Partial<TradePathStudyInput> = {}): TradePathStudyInput {
    const openedAt = '2026-08-23T00:00:00.000Z';
    const observations: RoeObservation[] = [
        { timestamp: '2026-08-23T00:05:00.000Z', timestampMs: Date.parse('2026-08-23T00:05:00.000Z'), roe: 0.06 },
        { timestamp: '2026-08-23T00:20:00.000Z', timestampMs: Date.parse('2026-08-23T00:20:00.000Z'), roe: -0.02 },
        { timestamp: '2026-08-23T01:00:00.000Z', timestampMs: Date.parse('2026-08-23T01:00:00.000Z'), roe: -0.12 },
        { timestamp: '2026-08-23T02:00:00.000Z', timestampMs: Date.parse('2026-08-23T02:00:00.000Z'), roe: 0.10 }
    ];
    return {
        tradeId: 'trade',
        symbol: 'BTCUSDT',
        side: 'LONG',
        openedAt,
        closedAt: '2026-08-23T02:00:00.000Z',
        entryPrice: 100,
        exitPrice: 100.6666666667,
        leverage: 15,
        finalRoe: 0.10,
        pnlUsdt: 1,
        recordedMaeRoe: -0.12,
        recordedMfeRoe: 0.10,
        observations,
        openRecord: { metadata: { cleanEntryGuard: {}, entryPolicy: {} } },
        closeRecord: {},
        e4Event: { metadata: { e4Score: 0.4 } },
        ...overrides
    };
}

describe('E4 entry MAE study', () => {
    it('separates a late reversal from early entry suffering', () => {
        const late = analyzeTradePath(input());
        expect(late.classification).toBe('LATE_REVERSAL');
        expect(late.first30MaeRoe).toBe(-0.02);
        expect(late.plus5BeforeMinus5).toBe(true);

        const early = analyzeTradePath(input({
            observations: [
                { timestamp: '2026-08-23T00:05:00.000Z', timestampMs: Date.parse('2026-08-23T00:05:00.000Z'), roe: -0.06 },
                { timestamp: '2026-08-23T00:20:00.000Z', timestampMs: Date.parse('2026-08-23T00:20:00.000Z'), roe: 0.08 }
            ],
            recordedMaeRoe: -0.06
        }));
        expect(early.classification).toBe('EARLY_ENTRY_SUFFERING');
    });

    it('replays a delayed long entry from sampled mark prices', () => {
        const result = simulateDelayedEntry(input(), 5);
        expect(result.available).toBe(true);
        expect(result.entryPrice).toBeCloseTo(100.4, 8);
        expect(result.maeRoe).toBeLessThan(-0.17);
    });

    it('simulates protection after a profit trigger', () => {
        const result = simulateProtection(input(), { name: 'test', triggerRoe: 0.05, floorRoe: 0 });
        expect(result.triggered).toBe(true);
        expect(result.exited).toBe(true);
        expect(result.simulatedFinalRoe).toBe(-0.02);
        expect(result.finalRoeDelta).toBeCloseTo(-0.12);
        expect(result.simulatedMaeRoe).toBe(-0.02);
        expect(result.maeImprovement).toBeCloseTo(0.10);
    });

    it('scales MAE for leverage stress', () => {
        const result = analyzeTradePath(input());
        expect(result.leverageStress.find((row) => row.leverage === 30)?.estimatedMaeRoe).toBeCloseTo(-0.24);
        expect(result.leverageStress.find((row) => row.leverage === 30)?.breachesConfiguredStop).toBe(false);
    });
});
