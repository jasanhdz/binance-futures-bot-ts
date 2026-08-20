import { afterEach, describe, expect, it, vi } from 'vitest';
import { AegisEntryContext, AegisEntryGuardPolicy } from '../AegisEntryDecisionTypes';
import {
    E4TailRiskGuardAdapter,
    E4TailRiskResponse,
    FROZEN_THRESHOLD
} from './E4TailRiskGuardAdapter';

const SIGNAL_TIMESTAMP = Date.parse('2026-08-20T12:04:59Z');
const DECISION_AT = '2026-08-20T12:00:00+00:00';
const policy: AegisEntryGuardPolicy = { enabled: true, mode: 'ENFORCE' };

function context(): AegisEntryContext {
    return {
        symbol: 'BTCUSDT',
        side: 'LONG',
        operational: {
            consecutiveLosses: 0,
            tradesToday: 0,
            openPositionsCount: 0,
            openProbePositions: 0,
            sameSymbolPositionExists: false,
            timestamp: SIGNAL_TIMESTAMP
        }
    } as AegisEntryContext;
}

function response(overrides: Partial<E4TailRiskResponse> = {}): E4TailRiskResponse {
    return {
        available: true,
        symbol: 'BTCUSDT',
        side: 'LONG',
        decision_at: DECISION_AT,
        score: 0.2,
        threshold: FROZEN_THRESHOLD,
        decision: 'ALLOW',
        reason: 'score_below_threshold',
        model_version: 'E4_TAIL_RISK_GUARD_V1',
        feature_snapshot_hash: 'feature-hash',
        feature_available_at: DECISION_AT,
        source_feed_lag_ms: { tf5m: 0 },
        computed_at: '2026-08-20T12:00:02+00:00',
        cache_age_ms: 100,
        snapshot_id: 'snapshot-1',
        ...overrides
    };
}

function fetchResponse(payload: E4TailRiskResponse, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload
    } as Response;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('E4TailRiskGuardAdapter integration contract', () => {
    it('derives request cycle from signal timestamp, not HTTP wall clock', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-20T12:05:01Z'));
        const fetchMock = vi.fn().mockResolvedValue(fetchResponse(response()));
        vi.stubGlobal('fetch', fetchMock);

        const result = await E4TailRiskGuardAdapter.evaluate(context(), policy);

        const request = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(request.decision_at).toBe(DECISION_AT);
        expect(result.guard.decision).toBe('ALLOW');
    });

    it('continues on a valid ALLOW', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(response())));
        expect((await E4TailRiskGuardAdapter.evaluate(context(), policy)).guard.decision).toBe('ALLOW');
    });

    it('denies on a valid BLOCK', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(response({
            score: 0.8,
            decision: 'BLOCK'
        }))));
        expect((await E4TailRiskGuardAdapter.evaluate(context(), policy)).guard.decision).toBe('DENY');
    });

    it('denies on timeout/network error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
        expect((await E4TailRiskGuardAdapter.evaluate(context(), policy)).guard.decision).toBe('DENY');
    });

    it('denies on 5xx', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(response(), 503)));
        expect((await E4TailRiskGuardAdapter.evaluate(context(), policy)).guard.decision).toBe('DENY');
    });

    it.each([
        ['threshold mismatch', { threshold: 0.5 }],
        ['decision mismatch', { score: 0.8, decision: 'ALLOW' as const }],
        ['symbol mismatch', { symbol: 'ETHUSDT' }],
        ['side mismatch', { side: 'SHORT' }],
        ['decision_at mismatch', { decision_at: '2026-08-20T12:05:00+00:00' }],
        ['empty model version', { model_version: '' }],
        ['empty feature hash', { feature_snapshot_hash: '' }]
    ])('denies on %s', async (_name, overrides) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(response(overrides))));
        const result = await E4TailRiskGuardAdapter.evaluate(context(), policy);
        expect(result.guard.decision).toBe('DENY');
        expect(result.guard.wouldBlock).toBe(true);
        expect(result.guard.enforced).toBe(true);
    });

    it('keeps transport failure shadow-only under SHADOW policy', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
        const result = await E4TailRiskGuardAdapter.evaluate(context(), {
            enabled: true,
            mode: 'SHADOW'
        });
        expect(result.guard.decision).toBe('SHADOW_DENY');
        expect(result.guard.enforced).toBe(false);
    });

    it('measures TS guard latency', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return fetchResponse(response());
        }));
        const result = await E4TailRiskGuardAdapter.evaluate(context(), policy);
        expect(Number(result.guard.metadata.tsGuardLatencyMs)).toBeGreaterThanOrEqual(1);
        console.log(JSON.stringify({ ts_guard_ms: result.guard.metadata.tsGuardLatencyMs }));
    });
});
