import { describe, expect, it } from 'vitest';
import { DEFAULT_AEGIS_REGIME_GUARD_CONFIG } from '../../AegisRegimeGuard';
import { AegisEntryContext, AegisRegimeContextRuntimeConfig } from '../AegisEntryDecisionTypes';
import { RegimeContextGuardAdapter } from './RegimeContextGuardAdapter';

const regimeContextConfig: AegisRegimeContextRuntimeConfig = {
  enabled: true,
  mode: 'SHADOW',
  timeframe: '5m',
  indicators: {
    emaFast: 7,
    emaMid: 25,
    emaSlow: 99,
    atrWindow: 14,
    volumeWindow: 20,
    bollingerWindow: 20,
    adxWindow: 14,
    choppinessWindow: 14,
  },
  thresholds: {
    maxChoppinessForMomentum: 55,
    minAdxForMomentum: 18,
    minVolumeRatioForMomentum: 1.3,
    maxAtrPercentileForAggressive: 0.8,
    maxExhaustionScore: 0.9,
  },
};

function context(overrides: Partial<AegisEntryContext> = {}): AegisEntryContext {
  const candles = Array.from({ length: 25 }, (_, index) => {
    const open = 1 + index * 0.01;
    return {
      open,
      high: open + 0.02,
      low: open - 0.005,
      close: open + 0.015,
      volume: index === 24 ? 200 : 100,
    };
  });
  return {
    symbol: 'XRPUSDT',
    side: 'LONG',
    finalAction: 'LONG',
    turboScore: 0.94,
    votes: { long: 3, short: 0, neutral: 0 },
    setupGrade: 'A',
    leverage: 20,
    requestedPositionFraction: 0.01,
    basePositionFraction: 0.01,
    signal: {
      symbol: 'XRPUSDT',
      action: 'LONG',
      confidence: 0.94,
      source: 'AEGIS_TURBO',
      longProb: 0.94,
      shortProb: 0.03,
      neutralProb: 0.03,
    },
    gate: {
      allowed: true,
      side: 'LONG',
      reason: 'ok',
      leverage: 20,
      positionFraction: 0.01,
      stopRoe: -0.15,
      takeProfitRoe: 0.25,
      trailingActivationRoe: 0.15,
      trailingCallbackRoe: 0.08,
      turboScore: 0.94,
      votes: { long: 3 },
    },
    entryQuality: {
      entryQualityScore: 0.8,
      tailRiskScore: 0.2,
      ruleGate: {
        enabled: true,
        mode: 'ENFORCE',
        config: {
          minScoreLong: 0.65,
          minScoreShort: 0.7,
          requireMomentumConfirm: false,
          antiFallingKnifeEnabled: false,
          antiFallingKnifeLookbackCandles: 3,
          maxAdverseRecentReturn: 0.003,
          overextensionEnabled: false,
          emaDistanceLimit: 0.006,
          volatilityEnabled: false,
          maxAtrPercentile: 0.75,
        },
        recentCandles: candles,
        emaFast: 1.2,
        atrPercentile: 0.4,
      },
    },
    eventRisk: { enabled: true, mode: 'NORMAL', enforce: false, isAltSymbol: true },
    regime: {
      config: {
        ...DEFAULT_AEGIS_REGIME_GUARD_CONFIG,
        enabled: true,
        mode: 'SHADOW',
      },
      contextConfig: regimeContextConfig,
      btcAction: 'LONG',
      ethAction: 'LONG',
      snapshotAgeSeconds: 60,
    },
    shortGate: {
      config: {
        enabled: false,
        mode: 'PREMIUM_ONLY',
        position_fraction_multiplier: 1,
        max_leverage: 0,
        block_symbols: [],
        allow_if_regime_bearish: false,
      },
    },
    decisionEnforcement: {
      config: {
        enabled: false,
        mode: 'OFF',
        block_do_not_enter: false,
        block_wait_confirmation: false,
        block_manual_only: false,
        block_entry_quality_shadow_block_when_event_risk: { enabled: false, event_modes: [] },
        event_risk_enforcement: {
          caution_blocks_weak_entries: false,
          risk_off_blocks_non_a_plus: false,
          manual_only_blocks_all_new_entries: false,
        },
        block_caution_would_block_unless_a_plus: false,
        block_all_entry_quality_shadow_block: false,
        block_all_tail_risk_high: false,
      },
    },
    operational: {
      consecutiveLosses: 0,
      tradesToday: 0,
      openPositionsCount: 0,
      openProbePositions: 0,
      sameSymbolPositionExists: false,
      timestamp: Date.now(),
    },
    ...overrides,
  };
}

describe('RegimeContextGuardAdapter', () => {
  it('OFF no evalua', () => {
    const result = RegimeContextGuardAdapter.evaluate(context(), { enabled: false, mode: 'OFF' });
    expect(result.guard.decision).toBe('NOT_APPLICABLE');
    expect(result.guard.enabled).toBe(false);
  });

  it('SHADOW evalua y no bloquea', () => {
    const result = RegimeContextGuardAdapter.evaluate(context(), { enabled: true, mode: 'SHADOW' });
    expect(result.guard.reason).toBe('regime_context_available');
    expect(result.guard.wouldBlock).toBe(false);
    expect(result.regimeContext?.label).toBe('MOMENTUM_UP');
  });

  it('ENFORCE sigue siendo informativo y no bloquea globalmente', () => {
    const result = RegimeContextGuardAdapter.evaluate(context(), {
      enabled: true,
      mode: 'ENFORCE',
    });
    expect(result.guard.decision).toBe('ALLOW');
    expect(result.guard.enforced).toBe(true);
    expect(result.guard.wouldBlock).toBe(false);
    expect(result.guard.metadata.globalBlockingDisabled).toBe(true);
    expect(result.guard.metadata.source).toBe('aegis_regime_guard_plus_indicators');
    expect(result.guard.metadata.technicalRegimePending).toBe(true);
  });

  it('datos insuficientes devuelve NOT_APPLICABLE sin bloquear', () => {
    const base = context();
    const result = RegimeContextGuardAdapter.evaluate(
      context({
        entryQuality: {
          ...base.entryQuality,
          ruleGate: {
            ...base.entryQuality.ruleGate,
            recentCandles: [],
            emaFast: undefined,
            atrPercentile: undefined,
          },
        },
        regime: { contextConfig: regimeContextConfig } as any,
      }),
      { enabled: true, mode: 'SHADOW' },
    );
    expect(result.guard.decision).toBe('NOT_APPLICABLE');
    expect(result.guard.wouldBlock).toBe(false);
    expect(result.guard.metadata).toMatchObject({
      source: 'aegis_regime_guard_plus_indicators',
      technicalRegimePending: true,
      globalBlockingDisabled: true,
    });
  });

  it('MOMENTUM_UP genera momentumLongAllowed=true', () => {
    const result = RegimeContextGuardAdapter.evaluate(context(), { enabled: true, mode: 'SHADOW' });
    expect(result.regimeContext?.momentumLongAllowed).toBe(true);
    expect(result.regimeContext?.momentumShortAllowed).toBe(false);
  });

  it('volumen alto sin exhaustion adicional no apaga momentum por si solo', () => {
    const result = RegimeContextGuardAdapter.evaluate(context(), { enabled: true, mode: 'SHADOW' });
    expect(result.regimeContext?.volumeState).toBe('HIGH');
    expect(result.regimeContext?.exhaustionRisk).toBeLessThan(0.6);
    expect(result.regimeContext?.momentumLongAllowed).toBe(true);
  });

  it('CHOP genera momentumLongAllowed=false', () => {
    const result = RegimeContextGuardAdapter.evaluate(
      context({
        regime: { ...context().regime!, btcAction: 'LONG', ethAction: 'SHORT' },
      }),
      { enabled: true, mode: 'SHADOW' },
    );
    expect(result.regimeContext?.label).toBe('CHOP');
    expect(result.regimeContext?.momentumLongAllowed).toBe(false);
  });
});
