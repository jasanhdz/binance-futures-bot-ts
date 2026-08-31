import { describe, expect, it, vi } from 'vitest';
import {
  AegisEntryContextBuilder,
  type AegisEntryContextBuilderDeps,
} from './AegisEntryContextBuilder';

function deps(overrides: Partial<AegisEntryContextBuilderDeps> = {}): AegisEntryContextBuilderDeps {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => 1_000_000,
    getEntryQualityConfig: () => ({ enabled: true, mode: 'SHADOW', config: {} }) as any,
    getEventRiskConfig: () =>
      ({
        enabled: true,
        mode: 'NORMAL',
        enforce: false,
        caution: {
          min_quality_score: 0.5,
          max_tail_risk_score: 0.5,
          require_btc_eth_confirmation: false,
        },
        risk_off: {
          min_quality_score: 0.8,
          max_tail_risk_score: 0.2,
          allow_only_a_plus: true,
        },
        manual_only: { block_new_entries: true },
      }) as any,
    getGlobalState: () => ({ mode: 'IDLE', lastProbeAt: 10, probeEntryTimestamps: [10] }),
    countStateOpenPositions: () => ({
      totalOpenPositions: 2,
      openMomentumPositions: 1,
      openProbePositions: 0,
    }),
    mostRecentStopLossAt: () => 940_000,
    readAegisRisk: () => ({ consecutiveLosses: 1, tradesToday: 3 }),
    stateForSymbol: () => ({ get: () => ({ mode: 'IDLE' }), set: vi.fn(), reset: vi.fn() }),
    hasOpenPosition: vi.fn().mockResolvedValue(false),
    buildEntryQualityMarketContext: () => ({ candleCount: 160 }),
    getRegimeGuardConfig: () => ({}) as any,
    getRegimeContextConfig: () => ({}) as any,
    getCleanEntryConfig: () => ({}) as any,
    getProbeModeConfig: () => ({}) as any,
    getShortGateConfig: () => ({}) as any,
    getDecisionEnforcementConfig: () => ({}) as any,
    ...overrides,
  };
}

describe('AegisEntryContextBuilder', () => {
  it('builds causal and operational context outside TradingService', async () => {
    const builder = new AegisEntryContextBuilder(deps());
    const context = await builder.build({
      symbol: 'LINKUSDT',
      side: 'LONG',
      signal: {
        action: 'LONG',
        confidence: 0.8,
        reason: 'test',
        aegis: {
          turbo: { raw: { action: 'LONG' }, gated: { action: 'LONG' } },
          event_risk_auto: {
            confidence: 0.9,
            snapshot_timestamp_ms: 940_000,
            btc_context: { action: 'LONG', score: 0.7 },
            eth_context: { action: 'NEUTRAL', score: 0.4 },
          },
        },
      } as any,
      gate: { allowed: true, side: 'LONG', leverage: 10, positionFraction: 0.1 } as any,
      baseGate: { allowed: true, side: 'LONG', leverage: 10, positionFraction: 0.2 } as any,
    });

    expect(context.eventRisk.isAltSymbol).toBe(true);
    expect(context.regime?.snapshotAgeSeconds).toBe(60);
    expect(context.operational).toMatchObject({
      consecutiveLosses: 1,
      tradesToday: 3,
      openPositionsCount: 2,
      openMomentumPositions: 1,
      recentStopLossMinutes: 1,
      sameSymbolPositionExists: false,
    });
  });

  it('fails closed when exchange ownership cannot be read', async () => {
    const serviceDeps = deps({ hasOpenPosition: vi.fn().mockRejectedValue(new Error('offline')) });
    const context = await new AegisEntryContextBuilder(serviceDeps).build({
      symbol: 'BTCUSDT',
      side: 'LONG',
      signal: { action: 'LONG', reason: 'test' } as any,
      gate: { allowed: true, side: 'LONG', leverage: 10, positionFraction: 0.1 } as any,
      baseGate: { allowed: true, side: 'LONG', leverage: 10, positionFraction: 0.1 } as any,
    });

    expect(context.operational.sameSymbolPositionExists).toBe(true);
    expect(serviceDeps.logger.error).toHaveBeenCalledWith(
      'aegis_position_ownership_read_failed_entry_blocked',
      expect.objectContaining({ entryPolicy: 'FAIL_CLOSED' }),
    );
  });
});
