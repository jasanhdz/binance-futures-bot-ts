import { describe, expect, it } from 'vitest';
import { DEFAULT_AEGIS_REGIME_GUARD_CONFIG } from '../../services/AegisRegimeGuard';
import { AegisEntryContext, AegisRegimeContextRuntimeConfig } from '../AegisEntryDecisionTypes';
import { RegimeContextGuardAdapter } from './RegimeContextGuardAdapter';
import { AegisLongRiskShadowGuardAdapter } from './AegisLongRiskShadowGuardAdapter';
import { RegimeGuardAdapter } from './RegimeGuardAdapter';

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

const now = 1_800_000_000_000;
function times(index: number, count = 40): { openTime: number; closeTime: number } {
  const closeTime = now - (count - index - 1) * 300_000;
  return { openTime: closeTime - 299_999, closeTime };
}

function context(overrides: Partial<AegisEntryContext> = {}): AegisEntryContext {
  const candles = Array.from({ length: 40 }, (_, index) => {
    const open = 1 + index * 0.01;
    return {
      ...times(index),
      open,
      high: open + 0.02,
      low: open - 0.005,
      close: open + 0.015,
      volume: index === 39 ? 200 : 100,
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
      timestamp: now,
    },
    ...overrides,
  };
}

describe('RegimeContextGuardAdapter', () => {
  it.each(['OFF', 'SHADOW', 'ENFORCE'] as const)(
    'keeps legacy authority and UNKNOWN snapshot policy in %s',
    (mode) => {
      for (const age of [undefined, NaN, Infinity, -1, 1_000_000]) {
        const base = context();
        base.regime!.snapshotAgeSeconds = age;
        base.regime!.config = { ...base.regime!.config, blockWhen: ['UNKNOWN'] };
        const legacy = RegimeGuardAdapter.evaluate(base, { enabled: true, mode });
        expect(legacy.guard.decision).toBe(
          mode === 'OFF' ? 'NOT_APPLICABLE' : mode === 'SHADOW' ? 'SHADOW_DENY' : 'DENY',
        );
        if (mode !== 'OFF') {
          expect(legacy.decision?.regime).toBe('UNKNOWN');
          expect(legacy.guard.metadata.authority).toMatchObject({
            source: 'LEGACY',
            role: mode === 'ENFORCE' ? 'AUTHORITATIVE' : 'INFORMATIONAL',
          });
        }
        const informational = RegimeContextGuardAdapter.evaluate(base, { enabled: true, mode });
        expect(informational.guard.wouldBlock).toBe(false);
        if (mode !== 'OFF') expect(informational.regimeContext?.label).toBe('UNKNOWN');
      }
    },
  );

  it.each([NaN, Infinity, -0.1, 1.1])(
    'rejects invalid auxiliary percentile %s',
    (atrPercentile) => {
      const base = context();
      base.entryQuality.ruleGate.atrPercentile = atrPercentile;
      const result = RegimeContextGuardAdapter.evaluate(base, { enabled: true, mode: 'SHADOW' });
      expect(result.regimeContext).toMatchObject({
        label: 'UNKNOWN',
        indicators: {},
        dataQuality: { valid: false, reasons: ['invalid_atr_percentile'] },
      });
    },
  );
  it('uses configured EMA windows and EMA slope, with a fixed EMA25 consumer feature', () => {
    const base = context();
    base.regime = {
      ...base.regime!,
      contextConfig: {
        ...regimeContextConfig,
        indicators: { ...regimeContextConfig.indicators, emaFast: 3, emaMid: 5, emaSlow: 10 },
      },
    };
    const result = RegimeContextGuardAdapter.evaluate(base, { enabled: true, mode: 'SHADOW' });
    const values = result.regimeContext!.indicators;
    expect(values.emaFast).toBeCloseTo(1.395);
    expect(values.emaMid).toBeCloseTo(1.385);
    expect(values.emaSlow).toBeCloseTo(1.36);
    expect(values.ema25).toBeCloseTo(1.285);
    expect(values.emaFastSlope).toBeCloseTo(0.01 / 1.385);
    expect(values.emaFastSlope).not.toBeCloseTo(0.01 / 1.395, 6);
    expect(result.guard.metadata.authority).toMatchObject({
      source: 'LEGACY',
      role: 'INFORMATIONAL',
    });
    base.regimeContext = result.regimeContext;
    base.entryQuality.ruleGate.currentPrice = 1.3;
    const longRisk = AegisLongRiskShadowGuardAdapter.evaluate({
      context: base,
      policy: { enabled: true, mode: 'SHADOW' },
      guards: {},
    });
    expect(longRisk.metadata.longRiskShadow).toMatchObject({
      marketWeakness: { belowEma25: false },
    });
  });

  it('warms EMA99 with real history and honors configured non-EMA windows', () => {
    const base = context();
    base.entryQuality.ruleGate.recentCandles = Array.from({ length: 120 }, (_, index) => {
      const close = 10 + index * 0.01 + Math.sin(index) * 0.02;
      return {
        ...times(index, 120),
        open: close,
        high: close + 0.1 + index * 0.001,
        low: close - 0.1,
        close,
        volume: 100 + index,
      };
    });
    const original = RegimeContextGuardAdapter.evaluate(base, {
      enabled: true,
      mode: 'SHADOW',
    }).regimeContext!;
    expect(original.indicators.emaSlow).toBeDefined();
    expect(original.indicators.emaSlowSlope).toBeDefined();
    base.regime = {
      ...base.regime!,
      contextConfig: {
        ...regimeContextConfig,
        indicators: {
          ...regimeContextConfig.indicators,
          atrWindow: 5,
          volumeWindow: 5,
          bollingerWindow: 5,
          adxWindow: 5,
          choppinessWindow: 5,
        },
      },
    };
    const changed = RegimeContextGuardAdapter.evaluate(base, {
      enabled: true,
      mode: 'SHADOW',
    }).regimeContext!;
    for (const key of ['atrPct', 'volumeRatio', 'bollingerWidth', 'adx', 'choppiness'] as const) {
      expect(changed.indicators[key]).toBeDefined();
      expect(changed.indicators[key]).not.toBe(original.indicators[key]);
    }
    expect(changed.indicators.ema25).toBe(original.indicators.ema25);
  });

  it.each(['SHADOW', 'ENFORCE'] as const)(
    'invalid candles become UNKNOWN without a context veto in %s',
    (mode) => {
      const base = context();
      base.entryQuality.ruleGate.recentCandles![2].volume = -1;
      const result = RegimeContextGuardAdapter.evaluate(base, { enabled: true, mode });
      expect(result.regimeContext).toMatchObject({
        label: 'UNKNOWN',
        confidence: 0,
        momentumLongAllowed: false,
        momentumShortAllowed: false,
        indicators: {},
        dataQuality: { valid: false, reasons: ['invalid_ohlcv'] },
      });
      expect(result.guard.decision).toBe('ALLOW');
      expect(result.guard.wouldBlock).toBe(false);
    },
  );

  it.each(['invalid_timestamp', 'invalid_cadence', 'last_candle_stale', 'last_candle_incomplete'])(
    'rejects %s before indicators',
    (reason) => {
      const base = context();
      const candles = base.entryQuality.ruleGate.recentCandles!;
      if (reason === 'invalid_timestamp') delete candles[0].openTime;
      if (reason === 'invalid_cadence') candles.splice(3, 1);
      if (reason === 'last_candle_stale') base.operational.timestamp += 300_001;
      if (reason === 'last_candle_incomplete') base.operational.timestamp -= 1;
      const result = RegimeContextGuardAdapter.evaluate(base, { enabled: true, mode: 'ENFORCE' });
      expect(result.regimeContext?.label).toBe('UNKNOWN');
      expect(result.regimeContext?.indicators).toEqual({});
      expect(result.regimeContext?.dataQuality?.reasons).toContain(reason);
    },
  );
  it('does not claim momentum permission before ADX warmup', () => {
    const base = context();
    base.entryQuality.ruleGate.recentCandles = base.entryQuality.ruleGate.recentCandles!.slice(-27);
    const result = RegimeContextGuardAdapter.evaluate(base, { enabled: true, mode: 'SHADOW' });
    expect(result.regimeContext?.indicators.adx).toBeUndefined();
    expect(result.regimeContext?.momentumLongAllowed).toBe(false);
  });
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

  it('calcula ADX agregado y no confunde oscilación con ADX 100', () => {
    const base = context();
    const candles = Array.from({ length: 40 }, (_, index) => {
      const center = 1 + (index % 2 === 0 ? 0.01 : -0.01);
      return {
        ...times(index),
        open: center,
        high: center + 0.02,
        low: center - 0.02,
        close: center,
        volume: 100,
      };
    });
    const result = RegimeContextGuardAdapter.evaluate(
      context({
        entryQuality: {
          ...base.entryQuality,
          ruleGate: { ...base.entryQuality.ruleGate, recentCandles: candles },
        },
      }),
      { enabled: true, mode: 'SHADOW' },
    );
    expect(result.regimeContext?.indicators.adx).toBeDefined();
    expect(result.regimeContext?.indicators.adx).toBeLessThan(100);
  });
});
