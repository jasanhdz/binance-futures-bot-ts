import { describe, expect, it, vi } from 'vitest';
import { BrainClient } from './client';
import { Candle, DecisionRequest, MarketSnapshot } from './contract';
import { StrictDecisionGate, OperationalContext } from './decision-gate';
import { ExpectedBrainManifest } from './manifest';
import {
  InMemoryShadowEvidenceRecorder, ShadowBrainCoordinator, validateCoordinatedShadowSnapshot,
} from './shadow';
import { decisionFixture, manifestFixture } from './brain-contract.test';

const symbols = manifestFixture().symbols;
const expected: ExpectedBrainManifest = {
  contractVersion: 'aegis-clean-rebuild-v1', universeId: 'aegis-operational-eleven-v1', symbols,
  symbolSetHash: manifestFixture().symbol_set_hash, timeframe: '5m',
  modelBundleId: 'aegis-offline-reference-v1', featureSchemaVersion: 'aegis-features-v1',
  featureHash: 'f'.repeat(64), configVersion: 'aegis-scientific-config-v1',
};

const snapshot = (): MarketSnapshot => {
  const closedAt = new Date('2026-07-17T12:00:00Z');
  return {
    closed_at: closedAt.toISOString(), timeframe: '5m', symbol_set_hash: expected.symbolSetHash,
    portfolio: { blocked_symbols: [], occupied_symbols: [], available_slots: 1, long_exposure_count: 0,
      short_exposure_count: 0, active_cooldowns: {}, accepted_decision_ids: [], operational_time: closedAt.toISOString() },
    series: symbols.map((symbol, symbolIndex) => {
      const candles: Candle[] = [];
      for (let index = 0; index < 60; index += 1) {
        const close = new Date(closedAt.getTime() - (59 - index) * 300_000);
        const open = new Date(close.getTime() - 300_000);
        candles.push({ open_time: open.toISOString(), close_time: close.toISOString(), open: 10 + symbolIndex,
          high: 10.2 + symbolIndex, low: 9.8 + symbolIndex, close: 10.1 + symbolIndex,
          volume: 1000 + index, is_closed: true, source: 'SHADOW_FIXTURE', sequence: String(index) });
      }
      return { symbol, candles, last_confirmed_close: closedAt.toISOString(),
        feed_quality: { missing_bars: 0, duplicate_bars: 0, source_lag_ms: 0 } };
    }),
  };
};

const operationalContext = (now: string): OperationalContext => ({
  mode: 'SHADOW', now, allowedSymbols: [...symbols], allowedSides: ['LONG', 'SHORT'], killSwitchActive: false,
  explicitAuthorization: false, executionEnabledByConfig: false, availableSlots: 1, occupiedSymbols: [],
  expectedModelBundleId: expected.modelBundleId, expectedSymbolSetHash: expected.symbolSetHash,
  expectedFeatureSchemaVersion: expected.featureSchemaVersion!, maximumDecisionAgeMs: 30_000,
  acceptedDecisionIds: new Set(),
});

const client = (overrides: Partial<BrainClient> = {}): BrainClient => ({
  getManifest: vi.fn().mockResolvedValue(manifestFixture()),
  evaluate: vi.fn().mockImplementation(async (request: DecisionRequest) => ({
    ...decisionFixture(), decision_cycle_id: request.decision_cycle_id,
    generated_at: request.snapshot.closed_at,
    expires_at: new Date(Date.parse(request.snapshot.closed_at) + 30_000).toISOString(),
  })),
  submitOutcome: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('shadow brain coordinator', () => {
  it('records a hypothetical decision while the operational gate remains denied', async () => {
    const recorder = new InMemoryShadowEvidenceRecorder();
    const brain = client();
    const coordinator = new ShadowBrainCoordinator({ client: brain, gate: new StrictDecisionGate(), recorder,
      expectedManifest: expected, operationalContext, now: () => new Date('2026-07-17T12:00:10Z') });
    const result = await coordinator.process(snapshot());
    expect(result.status).toBe('RECORDED');
    expect(result.shadow_action).toBe('WOULD_SHORT');
    expect(result.gate_result?.decision).toBe('DENY');
    expect(result.reason_codes).toContain('SHADOW_MODE_NON_EXECUTING');
    expect(result.execution_enabled).toBe(false);
    expect(brain.evaluate).toHaveBeenCalledTimes(1);
    expect(brain.submitOutcome).not.toHaveBeenCalled();
    expect(recorder.events).toHaveLength(1);
  });

  it('fails closed when Python is unavailable or its manifest is incompatible', async () => {
    const unavailableRecorder = new InMemoryShadowEvidenceRecorder();
    const unavailable = new ShadowBrainCoordinator({
      client: client({ getManifest: vi.fn().mockRejectedValue(new Error('unavailable')) }),
      gate: new StrictDecisionGate(), recorder: unavailableRecorder, expectedManifest: expected,
      operationalContext, now: () => new Date('2026-07-17T12:00:10Z'),
    });
    expect((await unavailable.process(snapshot())).reason_codes).toEqual(['SHADOW_BRAIN_UNAVAILABLE']);
    const mismatch = new ShadowBrainCoordinator({
      client: client({ getManifest: vi.fn().mockResolvedValue({ ...manifestFixture(), ready: false }) }),
      gate: new StrictDecisionGate(), recorder: new InMemoryShadowEvidenceRecorder(), expectedManifest: expected,
      operationalContext, now: () => new Date('2026-07-17T12:00:10Z'),
    });
    expect((await mismatch.process(snapshot())).reason_codes).toContain('BRAIN_NOT_READY');
  });

  it('rejects incomplete cycles before calling the scientific brain', async () => {
    const malformed = snapshot();
    const first = malformed.series[0];
    const broken = { ...malformed, series: [{ ...first, candles: first.candles.slice(0, -1) }, ...malformed.series.slice(1)] };
    const brain = client();
    const recorder = new InMemoryShadowEvidenceRecorder();
    const coordinator = new ShadowBrainCoordinator({ client: brain, gate: new StrictDecisionGate(), recorder,
      expectedManifest: expected, operationalContext, now: () => new Date('2026-07-17T12:00:10Z') });
    const result = await coordinator.process(broken);
    expect(result.status).toBe('FAILED_CLOSED');
    expect(result.reason_codes).toContain('SHADOW_PARTIAL_CANDLE');
    expect(brain.getManifest).not.toHaveBeenCalled();
    expect(brain.evaluate).not.toHaveBeenCalled();
  });

  it('deduplicates a coordinated candle cycle', async () => {
    const coordinator = new ShadowBrainCoordinator({ client: client(), gate: new StrictDecisionGate(),
      recorder: new InMemoryShadowEvidenceRecorder(), expectedManifest: expected, operationalContext,
      now: () => new Date('2026-07-17T12:00:10Z') });
    await coordinator.process(snapshot());
    await expect(coordinator.process(snapshot())).rejects.toMatchObject({ code: 'SHADOW_CYCLE_ALREADY_PROCESSED' });
  });

  it('validates universe, final candles, and temporal continuity', () => {
    expect(() => validateCoordinatedShadowSnapshot(snapshot(), expected)).not.toThrow();
    expect(() => validateCoordinatedShadowSnapshot({ ...snapshot(), symbol_set_hash: 'bad' }, expected))
      .toThrow('SHADOW_UNIVERSE_HASH_MISMATCH');
    const partial = snapshot();
    const first = partial.series[0]; const candles = [...first.candles];
    candles[candles.length - 1] = { ...candles[candles.length - 1], is_closed: false };
    expect(() => validateCoordinatedShadowSnapshot({ ...partial, series: [{ ...first, candles }, ...partial.series.slice(1)] }, expected))
      .toThrow('SHADOW_PARTIAL_CANDLE');
  });
});
