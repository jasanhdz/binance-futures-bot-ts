import { describe, expect, it } from 'vitest';
import {
  AegisMicroLiveGateConfig,
  AegisMicroLiveGateContext,
  buildAegisMicroLiveGateConfigFromEnv,
  shouldEnterAegisTurboMicroLive,
  shouldEnterStackingMomentumLive,
} from './AegisMicroLiveGate';
import {
  CURRENT_BRAIN_AUTHORITY,
  CURRENT_BRAIN_BUNDLE_SHA256,
  CURRENT_BRAIN_CONFIGURATION_SHA256,
  CURRENT_BRAIN_CONTRACT_VERSION,
  CURRENT_BRAIN_FEATURE_COUNT,
  CURRENT_BRAIN_FEATURE_SCHEMA,
  CURRENT_BRAIN_MODEL_ID,
  CURRENT_BRAIN_MODEL_SHA256,
} from './CurrentBrainCanonicalDecision';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function baseSignal() {
  return {
    aegis: {
      turbo: {
        raw: {
          action: 'LONG' as const,
          would_execute: true,
          turbo_score: 0.72,
          leverage_suggestion: 25,
          position_fraction: 0.18,
          votes: { long: 2, short: 0, neutral: 1 },
          reason: 'raw_long_agreement',
        },
        gated: {
          action: 'HOLD' as const,
          would_execute: false,
          reason: 'safe_regime_block',
          blocked_by: 'safe_regime',
        },
        stop_roe: -0.15,
        take_profit_roe: 0.25,
        trailing_activation_roe: 0.15,
        trailing_callback_roe: 0.08,
      },
    },
  };
}

function canonicalSignal(selected = true, side: 'LONG' | 'SHORT' = 'LONG') {
  const decision = selected ? 'ENTER_NOW' : 'DO_NOT_ENTER';
  return {
    aegis: {
      candidate: CURRENT_BRAIN_MODEL_ID,
      candidate_status: CURRENT_BRAIN_AUTHORITY,
      live_enabled: true,
      prod: {
        allowed: selected,
        execute: selected,
        action: selected ? side : ('HOLD' as const),
      },
      decision_brain: {
        contract_version: CURRENT_BRAIN_CONTRACT_VERSION,
        authority: CURRENT_BRAIN_AUTHORITY,
        mode: 'CURRENT_BRAIN_LIVE',
        execute: selected,
        selected,
        production_allowed: true,
        status: 'LOADED',
        model_version: CURRENT_BRAIN_MODEL_ID,
        model_sha256: CURRENT_BRAIN_MODEL_SHA256,
        bundle_sha256: CURRENT_BRAIN_BUNDLE_SHA256,
        configuration_sha256: CURRENT_BRAIN_CONFIGURATION_SHA256,
        feature_schema: CURRENT_BRAIN_FEATURE_SCHEMA,
        feature_count: CURRENT_BRAIN_FEATURE_COUNT,
        fallback: false,
        symbol: 'ETHUSDT',
        side,
        decision,
        recommendation: decision,
      },
    },
  };
}

function baseConfig(): AegisMicroLiveGateConfig {
  return {
    tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
    liveEnabled: true,
    allowShort: false,
    minScore: 0.5,
    leverageCap: 20,
    positionFractionCap: 1.0,
    maxTradesPerDay: 2,
    maxConsecutiveLosses: 2,
    dailyLossStopPct: 0.1,
    minCooldownMs: 15 * 60 * 1000,
    maxLiquidityStress: 0.7,
    stopRoe: -0.15,
    takeProfitRoe: 0.25,
    trailingActivationRoe: 0.15,
    trailingCallbackRoe: 0.08,
  };
}

function baseCtx(): AegisMicroLiveGateContext {
  const signal = canonicalSignal();
  (signal.aegis as any).turbo = baseSignal().aegis.turbo;
  return {
    symbol: 'ETHUSDT',
    signal,
    hasOpenPosition: false,
    tradesToday: 0,
    consecutiveLosses: 0,
    timeSinceLastExitMs: 20 * 60 * 1000,
    liquidityStress: 0.2,
    liquidityStressStatus: 'FRESH',
    liquidityStressAgeMs: 500,
    liquidityStressInputVersion: 'DEPTH20_PARTIAL_V1',
    dailyPnlPct: 0,
  };
}

describe('AegisMicroLiveGate', () => {
  it('allows standalone momentum without forging a canonical brain decision', () => {
    const ctx = baseCtx();
    ctx.signal = baseSignal();
    const decision = shouldEnterStackingMomentumLive(ctx, baseConfig(), 'LONG');

    expect(decision).toMatchObject({
      allowed: true,
      side: 'LONG',
      reason: 'allowed_main_stacking_momentum_replica',
    });
  });

  it('keeps position and short safety gates for standalone momentum', () => {
    const ctx = baseCtx();
    ctx.hasOpenPosition = true;
    expect(shouldEnterStackingMomentumLive(ctx, baseConfig(), 'LONG').reason).toBe(
      'position_already_open',
    );

    ctx.hasOpenPosition = false;
    expect(shouldEnterStackingMomentumLive(ctx, baseConfig(), 'SHORT').reason).toBe(
      'short_disabled',
    );
  });

  it('denies if tradingMode is not AEGIS_TURBO_MICRO_LIVE', () => {
    const config = baseConfig();
    config.tradingMode = 'AEGIS_SHADOW';

    const decision = shouldEnterAegisTurboMicroLive(baseCtx(), config);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('trading_mode_not_turbo_micro_live');
  });

  it('denies if liveEnabled=false', () => {
    const config = baseConfig();
    config.liveEnabled = false;

    const decision = shouldEnterAegisTurboMicroLive(baseCtx(), config);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('aegis_live_disabled');
  });

  it('does not require the legacy raw contract', () => {
    const ctx = baseCtx();
    delete ctx.signal.aegis!.turbo!.raw;

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed_current_brain_canonical_live');
  });

  it('denies if hasOpenPosition=true', () => {
    const ctx = baseCtx();
    ctx.hasOpenPosition = true;

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('position_already_open');
  });

  it('denies if tradesToday >= max', () => {
    const ctx = baseCtx();
    ctx.tradesToday = 2;

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('max_trades_per_day_reached');
  });

  it('denies if consecutiveLosses >= max', () => {
    const ctx = baseCtx();
    ctx.consecutiveLosses = 2;

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('max_consecutive_losses_reached');
  });

  it('denies if cooldown is active', () => {
    const ctx = baseCtx();
    ctx.timeSinceLastExitMs = 14 * 60 * 1000;

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('cooldown_active');
  });

  it('denies if liquidityStress > max', () => {
    const ctx = baseCtx();
    ctx.liquidityStress = 0.71;

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('liquidity_stress_block');
  });

  it.each([
    ['STALE', 'liquidity_data_stale'],
    ['NO_DATA', 'liquidity_data_no_data'],
  ] as const)('fails closed for %s liquidity data', (status, reason) => {
    const ctx = baseCtx();
    ctx.liquidityStressStatus = status;
    ctx.liquidityStressAgeMs = status === 'STALE' ? 30_001 : undefined;

    expect(shouldEnterAegisTurboMicroLive(ctx, baseConfig())).toMatchObject({
      allowed: false,
      reason,
      liquidityStressStatus: status,
      liquidityStressAgeMs: ctx.liquidityStressAgeMs,
      liquidityStressInputVersion: 'DEPTH20_PARTIAL_V1',
    });
  });

  it('uses scalar stress when liquidity data is fresh', () => {
    const decision = shouldEnterAegisTurboMicroLive(baseCtx(), baseConfig());
    expect(decision).toMatchObject({
      allowed: true,
      liquidityStressStatus: 'FRESH',
      liquidityStressAgeMs: 500,
      liquidityStressInputVersion: 'DEPTH20_PARTIAL_V1',
    });
  });

  it('denies if dailyPnlPct <= -dailyLossStopPct', () => {
    const ctx = baseCtx();
    ctx.dailyPnlPct = -0.1;

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('daily_loss_stop_reached');
  });

  it('does not reinterpret canonical selection through legacy raw.would_execute', () => {
    const ctx = baseCtx();
    ctx.signal.aegis!.turbo!.raw!.would_execute = false;

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('allowed_current_brain_canonical_live');
  });

  it('does not reinterpret canonical selection through legacy raw.action', () => {
    const ctx = baseCtx();
    ctx.signal.aegis!.turbo!.raw!.action = 'HOLD';

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('allowed_current_brain_canonical_live');
  });

  it('denies SHORT if allowShort=false', () => {
    const ctx = baseCtx();
    ctx.signal = canonicalSignal(true, 'SHORT');

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('short_disabled');
  });

  it('allows SHORT with the single real directional estimator', () => {
    const ctx = baseCtx();
    ctx.signal = canonicalSignal(true, 'SHORT');
    ctx.signal.aegis!.turbo = baseSignal().aegis.turbo;
    ctx.signal.aegis!.turbo!.raw!.votes = { long: 0, short: 1, neutral: 0 };
    const config = baseConfig();
    config.allowShort = true;

    const decision = shouldEnterAegisTurboMicroLive(ctx, config);

    expect(decision.allowed).toBe(true);
    expect(decision.side).toBe('SHORT');
    expect(decision.reason).toBe('allowed_current_brain_canonical_live');
  });

  it('does not reinterpret canonical selection through a legacy score threshold', () => {
    const ctx = baseCtx();
    ctx.signal.aegis!.turbo!.raw!.turbo_score = 0.49;

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('allowed_current_brain_canonical_live');
  });

  it('does not fabricate a second LONG vote', () => {
    const ctx = baseCtx();
    ctx.signal.aegis!.turbo!.raw!.votes = { long: 1, short: 0, neutral: 2 };

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('allowed_current_brain_canonical_live');
  });

  it('consumes an exact canonical current-brain decision without legacy raw votes or score', () => {
    const ctx = baseCtx();
    ctx.signal = canonicalSignal();

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision).toMatchObject({
      allowed: true,
      side: 'LONG',
      reason: 'allowed_current_brain_canonical_live',
      leverage: 15,
      positionFraction: 0.08,
    });
  });

  it('fails closed when a recognized canonical contract has a wrong artifact hash', () => {
    const ctx = baseCtx();
    ctx.signal = canonicalSignal();
    ctx.signal.aegis!.decision_brain!.model_sha256 = '0'.repeat(64);

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('current_brain_canonical_contract_invalid');
  });

  it('does not authorize entry for a canonical DO_NOT_ENTER decision', () => {
    const ctx = baseCtx();
    ctx.signal = canonicalSignal(false);

    const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

    expect(decision.reason).toBe('current_brain_canonical_do_not_enter');
  });

  it('allows LONG if all checks pass', () => {
    const decision = shouldEnterAegisTurboMicroLive(baseCtx(), baseConfig());

    expect(decision.allowed).toBe(true);
    expect(decision.side).toBe('LONG');
    expect(decision.reason).toBe('allowed_current_brain_canonical_live');
  });

  it('caps leverage at the configured YAML limit', () => {
    const decision = shouldEnterAegisTurboMicroLive(baseCtx(), baseConfig());

    expect(decision.leverage).toBe(15);
  });

  it('uses the configured YAML position fraction cap', () => {
    const decision = shouldEnterAegisTurboMicroLive(baseCtx(), baseConfig());

    expect(decision.positionFraction).toBe(0.08);
  });

  it('still respects a lower configured position fraction cap', () => {
    const config = baseConfig();
    config.positionFractionCap = 0.05;

    const decision = shouldEnterAegisTurboMicroLive(baseCtx(), config);

    expect(decision.positionFraction).toBe(0.05);
  });

  it('uses regime risk values instead of Aegis signal risk values', () => {
    const ctx = baseCtx();
    ctx.signal = clone(ctx.signal);
    ctx.signal.aegis!.turbo!.stop_roe = -0.5;
    ctx.signal.aegis!.turbo!.take_profit_roe = 0.9;
    ctx.signal.aegis!.turbo!.trailing_activation_roe = 0.4;
    ctx.signal.aegis!.turbo!.trailing_callback_roe = 0.3;
    const config = baseConfig();
    config.stopRoe = 0.15;
    config.takeProfitRoe = -0.25;
    config.trailingActivationRoe = -0.15;
    config.trailingCallbackRoe = -0.08;

    const decision = shouldEnterAegisTurboMicroLive(ctx, config);

    expect(decision.stopRoe).toBe(-0.15);
    expect(decision.takeProfitRoe).toBe(0.25);
    expect(decision.trailingActivationRoe).toBe(0.15);
    expect(decision.trailingCallbackRoe).toBe(0.08);
  });

  it('preserves gatedReason and gatedBlockedBy in decision', () => {
    const decision = shouldEnterAegisTurboMicroLive(baseCtx(), baseConfig());

    expect(decision.rawReason).toBe('raw_long_agreement');
    expect(decision.gatedReason).toBe('safe_regime_block');
    expect(decision.gatedBlockedBy).toBe('safe_regime');
  });

  it('falls back to defaults when YAML is absent', () => {
    const config = buildAegisMicroLiveGateConfigFromEnv(
      {
        TRADING_MODE: 'AEGIS_TURBO_MICRO_LIVE',
        AEGIS_LIVE_ENABLED: true,
        AEGIS_TURBO_ALLOW_SHORT: false,
        AEGIS_TURBO_POSITION_FRACTION: 0.1,
        AEGIS_TURBO_MAX_TRADES_PER_DAY: 2,
        AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES: 2,
        AEGIS_TURBO_DAILY_LOSS_STOP_PCT: 0.1,
      },
      undefined,
      {
        leverage: 15,
        entryThreshold: 0.5,
        hardStopRoe: -0.15,
        tpRoe: 0.25,
        trailingActivationRoe: 0.15,
        trailingCallbackRoe: 0.08,
      },
    );

    expect(config).toEqual({
      tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
      liveEnabled: true,
      allowShort: false,
      minScore: 0.5,
      leverageCap: 15,
      positionFractionCap: 0.1,
      maxTradesPerDay: 2,
      maxConsecutiveLosses: 2,
      dailyLossStopPct: 0.1,
      minCooldownMs: 15 * 60 * 1000,
      maxLiquidityStress: 0.7,
      stopRoe: -0.15,
      takeProfitRoe: 0.25,
      trailingActivationRoe: 0.15,
      trailingCallbackRoe: 0.08,
      yamlEnabled: false,
      yamlLiveEnabled: false,
      requireBrackets: true,
      closeIfBracketFails: true,
    });
  });
});
