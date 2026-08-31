import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../infra/config/environment';
import { AegisTradingSignal } from '../../strategies/aegis/domain/AegisStrategy';
import { DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG } from '../../strategies/aegis/domain/services/AegisCleanEntryGuard';
import {
  CURRENT_BRAIN_AUTHORITY,
  CURRENT_BRAIN_BUNDLE_SHA256,
  CURRENT_BRAIN_CONFIGURATION_SHA256,
  CURRENT_BRAIN_CONTRACT_VERSION,
  CURRENT_BRAIN_FEATURE_COUNT,
  CURRENT_BRAIN_FEATURE_SCHEMA,
  CURRENT_BRAIN_MODEL_ID,
  CURRENT_BRAIN_MODEL_SHA256,
} from '../../strategies/aegis/domain/CurrentBrainCanonicalDecision';
import { TradingService } from './TradingService';
import { LiquidityVoidDetector } from './LiquidityVoidDetector';
import { AegisMomentumRideRuntimeConfig } from '../../strategies/aegis/domain/entry/AegisEntryDecisionTypes';
import { E4TailRiskGuardAdapter } from '../../strategies/aegis/domain/entry/guards/E4TailRiskGuardAdapter';

const originalConfig = { ...CONFIG };

function setConfig(liveEnabled: boolean): void {
  (CONFIG as any).TRADING_MODE = 'AEGIS_TURBO_MICRO_LIVE';
  (CONFIG as any).AEGIS_LIVE_ENABLED = liveEnabled;
  (CONFIG as any).AEGIS_TURBO_ALLOW_SHORT = false;
  (CONFIG as any).AEGIS_TURBO_MIN_SCORE = 0.6;
  (CONFIG as any).AEGIS_TURBO_LEVERAGE = 20;
  (CONFIG as any).AEGIS_TURBO_POSITION_FRACTION = 1.0;
  (CONFIG as any).AEGIS_TURBO_MAX_TRADES_PER_DAY = 2;
  (CONFIG as any).AEGIS_TURBO_DAILY_LOSS_STOP_PCT = 0.1;
  (CONFIG as any).AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES = 2;
}

function restoreConfig(): void {
  Object.assign(CONFIG as any, originalConfig);
}

function yamlTurbo(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    live_enabled: true,
    allow_short: false,
    position_fraction_cap: 1.0,
    max_trades_per_day: 1,
    max_consecutive_losses: 1,
    daily_loss_stop_pct: 0.1,
    min_cooldown_ms: 15 * 60 * 1000,
    max_liquidity_stress: 0.7,
    require_brackets: true,
    close_if_bracket_fails: true,
    ...overrides,
  };
}

function regimeConfig(overrides: Record<string, unknown> = {}) {
  return {
    leverage: 20,
    hardStopRoe: -0.15,
    tpRoe: 0.25,
    entryThreshold: 0.6,
    maxHoldMs: 8 * 60 * 60 * 1000,
    beRoe: 0.08,
    trailingActivationRoe: 0.15,
    trailingCallbackRoe: 0.08,
    ...overrides,
  };
}

function withCanonicalDecision(
  signal: AegisTradingSignal,
  selected: boolean,
  side: 'LONG' | 'SHORT',
): AegisTradingSignal {
  const decision = selected ? 'ENTER_NOW' : 'DO_NOT_ENTER';
  const aegis = signal.metadata?.aegis!;
  return {
    ...signal,
    metadata: {
      ...signal.metadata,
      aegis: {
        ...aegis,
        candidate: CURRENT_BRAIN_MODEL_ID,
        candidate_status: CURRENT_BRAIN_AUTHORITY,
        live_enabled: true,
        prod: {
          allowed: selected,
          execute: selected,
          action: selected ? side : 'HOLD',
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
          symbol: signal.symbol,
          side,
          decision,
          recommendation: decision,
        },
      },
    },
  };
}

function validSignal(): AegisTradingSignal {
  const signal: AegisTradingSignal = {
    symbol: 'ETHUSDT',
    action: 'PASS',
    confidence: 0,
    source: 'AEGIS_TURBO',
    longProb: 0.72,
    shortProb: 0.12,
    neutralProb: 0.16,
    metadata: {
      aegis: {
        turbo: {
          raw: {
            action: 'LONG',
            would_execute: true,
            turbo_score: 0.72,
            leverage_suggestion: 25,
            position_fraction: 0.18,
            votes: { long: 2, short: 0, neutral: 1 },
            reason: 'raw_long_agreement',
          },
          gated: {
            action: 'LONG',
            would_execute: true,
            reason: 'raw_long_agreement',
            blocked_by: null,
          },
          stop_roe: -0.15,
          take_profit_roe: 0.25,
          trailing_activation_roe: 0.15,
          trailing_callback_roe: 0.08,
        },
      },
    },
  };
  return withCanonicalDecision(signal, true, 'LONG');
}

function validSignalWithShadowEntryQuality(): AegisTradingSignal {
  const signal = validSignal();
  return {
    ...signal,
    metadata: {
      ...signal.metadata,
      aegis: {
        ...signal.metadata?.aegis,
        entry_quality_model: {
          mode: 'SHADOW',
          execute: false,
          production_allowed: false,
          status: 'RESEARCH_CANDIDATE_NOT_LIVE',
          entry_quality_score: 0.2,
          tail_risk_score: 0.9,
          recommendation: 'BLOCK_SHADOW',
          reason: 'quality_low_and_tail_high',
          feature_status: 'ok',
          feature_parity_pct: 100,
          missing_features_count: 0,
          model_scope: 'global',
          model_version: 'v020',
        },
      },
    },
  };
}

function validSignalWithDecisionBrain(
  decision: string,
  entryQualityRecommendation = 'ALLOW_SHADOW',
): AegisTradingSignal {
  const signal = withCanonicalDecision(validSignal(), decision === 'ENTER_NOW', 'LONG');
  return {
    ...signal,
    metadata: {
      ...signal.metadata,
      aegis: {
        ...signal.metadata?.aegis,
        entry_quality_model: {
          mode: 'SHADOW',
          execute: false,
          production_allowed: false,
          status: 'RESEARCH_CANDIDATE_NOT_LIVE',
          entry_quality_score: entryQualityRecommendation === 'ALLOW_SHADOW' ? 0.82 : 0.2,
          tail_risk_score: entryQualityRecommendation === 'ALLOW_SHADOW' ? 0.2 : 0.8,
          recommendation: entryQualityRecommendation,
          feature_status: 'ok',
          feature_parity_pct: 100,
          missing_features_count: 0,
          model_scope: 'global',
          model_version: 'v020',
        },
        event_risk_auto: {
          mode: 'SHADOW',
          suggested_mode: 'NORMAL',
          confidence: 0.8,
          btc_context: { action: 'LONG', score: 0.8 },
          eth_context: { action: 'LONG', score: 0.8 },
          execute: false,
          production_allowed: false,
        },
      },
    },
  };
}

function signalWithRegimeContext(
  input: {
    symbol?: string;
    turboScore?: number;
    votes?: { long?: number; short?: number; neutral?: number };
    setupGrade?: string;
    btcAction?: string;
    ethAction?: string;
  } = {},
): AegisTradingSignal {
  const signal = validSignalWithDecisionBrain('ENTER_NOW');
  const result: AegisTradingSignal = {
    ...signal,
    symbol: input.symbol ?? signal.symbol,
    metadata: {
      ...signal.metadata,
      aegis: {
        ...signal.metadata?.aegis,
        turbo: {
          ...signal.metadata?.aegis?.turbo,
          raw: {
            ...signal.metadata?.aegis?.turbo?.raw,
            turbo_score: input.turboScore ?? 0.94,
            votes: input.votes ?? { long: 3, short: 0, neutral: 0 },
          },
        },
        clean_entry_guard: {
          setupGrade: input.setupGrade ?? 'A',
        },
        event_risk_auto: {
          ...signal.metadata?.aegis?.event_risk_auto,
          btc_context: {
            action: input.btcAction ?? 'LONG',
            score: 0.82,
            votes: { long: 3, short: 0, neutral: 0 },
          },
          eth_context: {
            action: input.ethAction ?? 'LONG',
            score: 0.8,
            votes: { long: 3, short: 0, neutral: 0 },
          },
          snapshot_age_seconds: 60,
        } as any,
      },
    },
  };
  return withCanonicalDecision(result, true, 'LONG');
}

function shortSignal(symbol = 'BTCUSDT', score = 0.84, shortVotes = 3): AegisTradingSignal {
  const signal: AegisTradingSignal = {
    symbol,
    action: 'PASS',
    confidence: 0,
    source: 'AEGIS_TURBO',
    longProb: 0.1,
    shortProb: 0.8,
    neutralProb: 0.1,
    metadata: {
      aegis: {
        turbo: {
          raw: {
            action: 'SHORT',
            would_execute: true,
            turbo_score: score,
            leverage_suggestion: 20,
            position_fraction: 0.2,
            votes: { long: 0, short: shortVotes, neutral: 3 - shortVotes },
            reason: 'raw_short_agreement',
          },
          gated: {
            action: 'SHORT',
            would_execute: true,
            reason: 'raw_short_agreement',
            blocked_by: null,
          },
          stop_roe: -0.15,
          take_profit_roe: 0.25,
          trailing_activation_roe: 0.15,
          trailing_callback_roe: 0.08,
        },
      },
    },
  };
  return withCanonicalDecision(signal, true, 'SHORT');
}

function phaseOShortSignal(symbol = 'BTCUSDT', score = 0.84, shortVotes = 3): AegisTradingSignal {
  const signal = shortSignal(symbol, score, shortVotes);
  const turbo = signal.metadata!.aegis!.turbo as any;
  turbo.raw.phase_o = {
    phase_o_live_enabled: true,
    phase_o_live_mode: 'experimental_short_only',
    phase_o_link_avoid_only: false,
    phase_o_link_entry_enabled: false,
  };
  return signal;
}

function phaseOShortSignalAtPath(
  path: 'metadata.aegis.turbo' | 'metadata.turbo' | 'aegis.turbo',
  symbol = 'BTCUSDT',
): AegisTradingSignal {
  const signal = shortSignal(symbol, 0.79, 3) as any;
  const turbo = signal.metadata.aegis.turbo;
  const phaseO = {
    phase_o_live_enabled: true,
    phase_o_live_mode: 'experimental_short_only',
    phase_o_link_avoid_only: false,
    phase_o_link_entry_enabled: false,
    phase_o_source_model_paths: { short_30d: '/models/turbo/BTCUSDT/phase_o_x/model.joblib' },
  };
  delete turbo.raw.phase_o;
  if (path === 'metadata.aegis.turbo') {
    turbo.phase_o = phaseO;
  } else if (path === 'metadata.turbo') {
    signal.metadata = { turbo: { ...turbo, phase_o: phaseO } };
  } else {
    signal.aegis = { turbo: { ...turbo, phase_o: phaseO } };
    signal.metadata = { rawPrediction: { aegis: signal.aegis } };
  }
  return signal;
}

function phaseOLinkAvoidOnlySignal(): AegisTradingSignal {
  const signal = phaseOShortSignalAtPath('metadata.aegis.turbo', 'LINKUSDT') as any;
  signal.metadata.aegis.turbo.phase_o.phase_o_link_avoid_only = true;
  signal.metadata.aegis.turbo.phase_o.phase_o_link_entry_enabled = false;
  return signal;
}

function entryQualityConfig(overrides: Record<string, any> = {}) {
  const { config: configOverrides = {}, ...rest } = overrides;
  return {
    enabled: false,
    mode: 'OFF',
    config: {
      minScoreLong: 0.65,
      minScoreShort: 0.7,
      requireMomentumConfirm: true,
      antiFallingKnifeEnabled: true,
      antiFallingKnifeLookbackCandles: 3,
      maxAdverseRecentReturn: 0.003,
      overextensionEnabled: true,
      emaDistanceLimit: 0.006,
      volatilityEnabled: true,
      maxAtrPercentile: 0.75,
      ...configOverrides,
    },
    ...rest,
  };
}

function regimeGuardConfig(overrides: Record<string, any> = {}) {
  return {
    enabled: true,
    mode: 'SHADOW',
    source: 'HYBRID_HEURISTIC',
    allowWhen: [
      'MOMENTUM_UP',
      'MOMENTUM_DOWN',
      'BREAKOUT_UP',
      'BREAKOUT_DOWN',
      'TREND_UP',
      'TREND_DOWN',
    ],
    blockWhen: ['CHOP', 'EXHAUSTION', 'RISK_OFF', 'HIGH_VOL_RISK', 'UNKNOWN'],
    minConfidence: 0.6,
    maxSnapshotAgeSeconds: 900,
    requireBtcEthAlignmentForAlts: true,
    allowAltLongWhenBtcShort: false,
    allowAltShortWhenBtcLong: false,
    highTailRiskThreshold: 0.45,
    telemetry: {
      logAllEvaluations: true,
      includeInEntryMetadata: true,
    },
    ...overrides,
  };
}

function entryPolicyWithRegime(mode: 'OFF' | 'SHADOW' | 'ENFORCE') {
  return {
    enabled: true,
    guards: {
      regime: { enabled: mode !== 'OFF', mode },
      short_gate: { enabled: false, mode: 'OFF' },
      entry_quality: { enabled: false, mode: 'OFF' },
      event_risk: { enabled: false, mode: 'OFF' },
      decision_brain: { enabled: false, mode: 'OFF' },
      clean_entry: { enabled: false, mode: 'OFF' },
      probe_mode: { enabled: false, mode: 'OFF' },
    },
  };
}

function decisionEnforcementConfig(overrides: Record<string, any> = {}) {
  return {
    enabled: true,
    mode: 'CONSERVATIVE',
    block_do_not_enter: true,
    block_wait_confirmation: true,
    block_manual_only: true,
    block_entry_quality_shadow_block_when_event_risk: {
      enabled: true,
      event_modes: ['CAUTION', 'RISK_OFF', 'MANUAL_ONLY'],
    },
    event_risk_enforcement: {
      caution_blocks_weak_entries: true,
      risk_off_blocks_non_a_plus: true,
      manual_only_blocks_all_new_entries: true,
    },
    block_caution_would_block_unless_a_plus: true,
    block_all_entry_quality_shadow_block: true,
    block_all_tail_risk_high: false,
    ...overrides,
  };
}

function cleanEntryGuardConfig(overrides: Record<string, any> = {}) {
  return {
    ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG,
    ...overrides,
    applyTo: {
      ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG.applyTo,
      ...(overrides.applyTo ?? {}),
    },
    dirtyConditions: {
      ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG.dirtyConditions,
      ...(overrides.dirtyConditions ?? {}),
    },
    cleanConditions: {
      ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG.cleanConditions,
      ...(overrides.cleanConditions ?? {}),
    },
    exception: {
      ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG.exception,
      ...(overrides.exception ?? {}),
    },
    telemetry: {
      ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG.telemetry,
      ...(overrides.telemetry ?? {}),
    },
  };
}

function probeModeConfig(overrides: Record<string, any> = {}) {
  return {
    enabled: true,
    mode: 'ENFORCE',
    apply_when_event_risk: ['CAUTION'],
    min_turbo_score: 0.9,
    max_tail_risk_score: 0.3,
    require_decision_brain: 'ENTER_NOW',
    require_entry_quality_allow: true,
    require_feature_status_ok: true,
    min_feature_parity_pct: 95,
    allow_if_blocked_only_by: [
      'clean_entry_event_risk_would_block',
      'caution_btc_eth_not_confirmed',
    ],
    max_probe_entries_per_hour: 1,
    min_minutes_between_probe_entries: 60,
    max_open_probe_positions: 1,
    max_total_open_positions_when_probe: 2,
    block_after_consecutive_losses: 2,
    block_after_recent_stop_loss_minutes: 60,
    ...overrides,
  };
}

function probeSignal(overrides: Record<string, any> = {}): AegisTradingSignal {
  const signal = validSignalWithDecisionBrain(
    overrides.decision ?? 'ENTER_NOW',
    overrides.entryQualityRecommendation ?? 'ALLOW_SHADOW',
  );
  signal.symbol = overrides.symbol ?? 'ADAUSDT';
  const canonical = withCanonicalDecision(
    signal,
    (overrides.decision ?? 'ENTER_NOW') === 'ENTER_NOW',
    'LONG',
  );
  const aegis = canonical.metadata!.aegis as any;
  aegis.turbo.raw.turbo_score = overrides.turboScore ?? 0.94;
  aegis.turbo.raw.votes = overrides.votes ?? { long: 2, short: 1, neutral: 0 };
  aegis.turbo.gated.action = 'LONG';
  aegis.entry_quality_model = {
    ...aegis.entry_quality_model,
    recommendation: overrides.entryQualityRecommendation ?? 'ALLOW_SHADOW',
    entry_quality_score: overrides.entryQualityScore ?? 0.82,
    tail_risk_score: overrides.tailRiskScore ?? 0.2,
    feature_status: overrides.featureStatus ?? 'ok',
    feature_parity_pct: overrides.featureParityPct ?? 100,
  };
  aegis.event_risk_auto = {
    mode: 'SHADOW',
    suggested_mode: 'CAUTION',
    confidence: 0.8,
    btc_context: { action: 'SHORT', score: 0.62 },
    eth_context: { action: 'LONG', score: 0.61 },
    execute: false,
    production_allowed: false,
  };
  return canonical;
}

function cachedCandles(closes: number[]) {
  return closes.map((close, index) => ({
    openTime: index,
    timestamp: index,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 100,
    buyVolume: 50,
    closeTime: index + 1,
  }));
}

function momentumCandles() {
  const base = Array.from({ length: 20 }, (_, index) => {
    const close = 3000 + index;
    return {
      openTime: index,
      timestamp: index,
      open: close - 0.4,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100,
      buyVolume: 60,
      closeTime: index + 1,
    };
  });
  return [
    ...base,
    {
      openTime: 21,
      timestamp: 21,
      open: 3020,
      high: 3032,
      low: 3018,
      close: 3030,
      volume: 180,
      buyVolume: 130,
      closeTime: 22,
    },
    {
      openTime: 22,
      timestamp: 22,
      open: 3030,
      high: 3044,
      low: 3028,
      close: 3040,
      volume: 200,
      buyVolume: 150,
      closeTime: 23,
    },
    {
      openTime: 23,
      timestamp: 23,
      open: 3040,
      high: 3056,
      low: 3038,
      close: 3052,
      volume: 240,
      buyVolume: 190,
      closeTime: 24,
    },
  ];
}

function momentumRideRuntimeConfig(positionFraction = 0.015): AegisMomentumRideRuntimeConfig {
  return {
    enabled: true,
    mode: 'ENFORCE',
    researchMode: true,
    standaloneMainReplica: false,
    aegisFallbackEnabled: true,
    regimeFilter: {
      enabled: true,
      useAsGate: false,
      recordMetadata: true,
      ignoreForEntry: true,
    },
    allowWhenAegisDenied: false,
    requireAegisDirectionConfirmation: true,
    allowMomentumAgainstAegis: false,
    requireBtcEthNotContradicting: true,
    requireBtcEthConfirmation: false,
    symbols: {
      ETHUSDT: {
        enabled: true,
        mode: 'ENFORCE',
        long: {
          enabled: true,
          leverage: 30,
          positionFraction,
          minTurboScore: 0.9,
          minVolumeRatio: 1.3,
          momentumCandles: 3,
          maxTailRiskScore: 0.3,
          allowedRegimes: ['MOMENTUM_UP', 'TREND_UP', 'BREAKOUT_UP'],
          requireCloseNearExtreme: true,
          minCloseLocation: 0.7,
          maxWickRatio: 0.35,
          maxOverextensionPct: 0.2,
        },
        short: {
          enabled: false,
          leverage: 10,
          positionFraction: 0.01,
          minTurboScore: 0.94,
          minVolumeRatio: 1.7,
          momentumCandles: 3,
          maxTailRiskScore: 0.25,
          allowedRegimes: ['MOMENTUM_DOWN', 'TREND_DOWN', 'BREAKOUT_DOWN'],
          requireCloseNearExtreme: true,
          minCloseLocation: 0.7,
          maxWickRatio: 0.35,
          maxOverextensionPct: 0.08,
        },
      },
    },
    safetyCaps: {
      maxLeverage: 50,
      maxPositionFraction: 0.02,
      maxOpenMomentumPositions: 1,
      maxTotalOpenPositionsWhenMomentum: 2,
      maxMomentumTradesPerDay: 3,
      maxConsecutiveMomentumLosses: 2,
      cooldownAfterLossMinutes: 60,
      disableSymbolAfterStopLossMinutes: 120,
      requireBrackets: true,
      requireProfitProtection: true,
    },
  };
}

function makeHarness(
  options: {
    liveEnabled?: boolean;
    yaml?: any;
    symbols?: string[];
    symbolModes?: Record<string, 'OFF' | 'SHADOW' | 'LIVE'>;
    closeOrders?: any[];
    closeOrdersSequence?: any[][];
    balance?: number;
    readActivePosition?: any;
    readActivePositionSequence?: any[];
    placeStopCloseReject?: boolean;
    placeTpCloseReject?: boolean;
    closeSideMarketSafeReject?: boolean;
    markPrice?: number;
    lastCandle?: any;
    initialState?: any;
    symbolStates?: Record<string, any>;
    accountSnapshot?: any;
    symbolFilters?: any;
    regime?: any;
    guardian?: any;
    signal?: AegisTradingSignal;
    portfolioRisk?: any;
    shortGate?: any;
    eventRisk?: any;
    regimeGuard?: any;
    decisionEnforcement?: any;
    cleanEntryGuard?: any;
    probeMode?: any;
    telegramNotifications?: any;
    positionFractionOverride?: any;
    phaseOShortLive?: any;
    entryQuality?: any;
    entryPolicy?: any;
    cachedCandles?: any[];
    momentumRide?: any;
    regimeContext?: any;
    closedTradeOutcomes?: Array<{ tradeId: string; closedAt: string; pnlUsdt: number }>;
    preserveUnverifiedState?: boolean;
  } = {},
) {
  setConfig(options.liveEnabled ?? true);
  const closeOrders = options.closeOrders ?? [
    { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 2970, owner: 'BOT' },
    { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 3050, owner: 'BOT' },
  ];
  const normalizeCloseOrders = (orders: any[], side: 'LONG' | 'SHORT') =>
    orders.map((order) => ({
      ...order,
      side: order.side ?? (side === 'LONG' ? 'SELL' : 'BUY'),
      positionSide: order.positionSide ?? side,
      workingType: order.workingType ?? 'MARK_PRICE',
      ...(order.closePosition === undefined && order.reduceOnly === undefined
        ? { closePosition: true }
        : {}),
    }));
  const position = options.readActivePosition ?? {
    sideMode: 'LONG',
    qtyAbs: 0.01,
    entryPrice: 3000,
    leverage: 20,
    isolatedMargin: 2,
  };
  const readActivePosition = vi.fn();
  if (options.readActivePositionSequence) {
    for (const value of options.readActivePositionSequence) {
      readActivePosition.mockResolvedValueOnce(value);
    }
    readActivePosition.mockResolvedValue(
      options.readActivePositionSequence[options.readActivePositionSequence.length - 1] ?? null,
    );
  } else {
    readActivePosition.mockResolvedValue(position);
  }
  const listCloseOrdersForSide = vi.fn();
  if (options.closeOrdersSequence) {
    let closeOrdersCall = 0;
    listCloseOrdersForSide.mockImplementation(async (_symbol: string, side: 'LONG' | 'SHORT') => {
      const orders =
        options.closeOrdersSequence![
          Math.min(closeOrdersCall++, options.closeOrdersSequence!.length - 1)
        ] ?? [];
      return normalizeCloseOrders(orders, side);
    });
  } else {
    listCloseOrdersForSide.mockImplementation(async (_symbol: string, side: 'LONG' | 'SHORT') => {
      if (options.closeOrders === undefined) {
        const stop =
          exchange.placeStopClose.mock.calls[exchange.placeStopClose.mock.calls.length - 1];
        const takeProfit =
          exchange.placeTpClose.mock.calls[exchange.placeTpClose.mock.calls.length - 1];
        return normalizeCloseOrders(
          [
            { orderId: 'sl', type: 'STOP_MARKET', stopPrice: stop?.[2], owner: 'BOT' },
            { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: takeProfit?.[2], owner: 'BOT' },
          ],
          side,
        );
      }
      return normalizeCloseOrders(closeOrders, side);
    });
  }
  const exchange = {
    getUSDTBalance: vi.fn().mockResolvedValue(options.balance ?? 20),
    getUSDTAccountSnapshot: vi.fn().mockResolvedValue(
      options.accountSnapshot ?? {
        walletBalance: options.balance ?? 20,
        availableBalance: options.balance ?? 20,
        equityTotal: options.balance ?? 20,
      },
    ),
    getMarkPrice: vi.fn().mockResolvedValue(options.markPrice ?? 3000),
    getSymbolFilters: vi.fn().mockResolvedValue(
      options.symbolFilters ?? {
        qtyPrecision: 3,
        pricePrecision: 2,
        minNotional: 5,
        tickSize: 0.01,
        stepSize: 0.001,
      },
    ),
    setLeverage: vi.fn().mockResolvedValue(undefined),
    ensureMarginType: vi.fn().mockResolvedValue(undefined),
    marketOpen: vi.fn().mockResolvedValue({ avgPrice: 3000, orderId: 'entry-1' }),
    readMarketOpenByClientOrderId: vi.fn().mockResolvedValue(null),
    readActivePosition,
    placeStopClose: options.placeStopCloseReject
      ? vi.fn().mockRejectedValue(new Error('stop failed'))
      : vi.fn().mockResolvedValue(true),
    placeTpClose: options.placeTpCloseReject
      ? vi.fn().mockRejectedValue(new Error('tp failed'))
      : vi.fn().mockResolvedValue(true),
    listCloseOrdersForSide,
    cancelOrderById: vi.fn().mockResolvedValue(undefined),
    closeSideMarketSafe: options.closeSideMarketSafeReject
      ? vi.fn().mockRejectedValue(new Error('close failed'))
      : vi.fn().mockResolvedValue(undefined),
    cancelStopOrdersForSide: vi.fn().mockResolvedValue(undefined),
    hasOpenPosition: vi.fn().mockResolvedValue(false),
    getServerTime: vi.fn().mockResolvedValue(Date.now()),
    getLastCandle: vi.fn().mockResolvedValue(options.lastCandle ?? null),
    getCandles: vi
      .fn()
      .mockImplementation(async (_symbol: string, _interval: string, _limit: number) => {
        return options.cachedCandles ?? [];
      }),
    getCachedCandles: vi.fn().mockReturnValue(options.cachedCandles ?? []),
    subscribeToCandles: vi.fn(),
    subscribeToPartialDepth: vi.fn(
      (
        _symbol: string,
        _levels: number,
        _speed: string,
        onDepth: (depth: { bids: string[][]; asks: string[][] }) => void,
      ) => {
        const levels = Array.from({ length: 20 }, (_, index) => [String(3000 - index), '1']);
        const asks = Array.from({ length: 20 }, (_, index) => [String(3000 + index), '1']);
        onDepth({ bids: levels, asks });
      },
    ),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const verifiedState = (value: any) =>
    value && value.mode !== 'IDLE' && !options.preserveUnverifiedState
      ? {
          positionOwner: 'AEGIS',
          tradeOrigin: 'BOT',
          ownershipStatus: 'VERIFIED',
          eligibleForBotMetrics: true,
          ...value,
        }
      : value;
  let currentState: any = verifiedState(options.initialState) ?? {
    mode: 'IDLE',
    currentRegime: 'AEGIS_TURBO',
    lastExitAt: Date.now() - 20 * 60 * 1000,
  };
  const state = {
    get: vi.fn(() => currentState),
    set: vi.fn((patch: any) => {
      currentState = { ...currentState, ...patch };
      return currentState;
    }),
    reset: vi.fn(),
  } as any;
  const symbolStores = new Map<string, any>();
  if (options.symbolStates) {
    for (const [symbol, initial] of Object.entries(options.symbolStates)) {
      let scopedState: any = verifiedState(initial);
      symbolStores.set(symbol, {
        get: vi.fn(() => scopedState),
        set: vi.fn((patch: any) => {
          scopedState = { ...scopedState, ...patch };
          return scopedState;
        }),
        reset: vi.fn(() => {
          scopedState = { mode: 'IDLE' };
        }),
      });
    }
    state.forSymbol = vi.fn((symbol: string) => {
      if (!symbolStores.has(symbol)) {
        let scopedState: any = {
          mode: 'IDLE',
          currentRegime: 'AEGIS_TURBO',
          lastExitAt: Date.now() - 20 * 60 * 1000,
        };
        symbolStores.set(symbol, {
          get: vi.fn(() => scopedState),
          set: vi.fn((patch: any) => {
            scopedState = { ...scopedState, ...patch };
            return scopedState;
          }),
          reset: vi.fn(() => {
            scopedState = { mode: 'IDLE' };
          }),
        });
      }
      return symbolStores.get(symbol);
    });
  }
  const notifier = { sendMessage: vi.fn(), sendAlert: vi.fn() };
  const symbolModes = options.symbolModes ?? { ETHUSDT: 'LIVE' as const };
  const configManager: any = {
    getAegisTurboConfig: vi.fn(() => options.yaml ?? yamlTurbo()),
    getAegisPhaseOShortLiveConfig: vi.fn(
      () =>
        options.phaseOShortLive ?? {
          enabled: true,
          max_open_phase_o_positions: 9,
          max_phase_o_trades_per_day: 20,
          require_brackets: true,
          allow_link_entry: false,
          link_avoid_only: true,
        },
    ),
    getAegisPortfolioRiskConfig: vi.fn(() => options.portfolioRisk ?? { enabled: false }),
    getAegisShortGateConfig: vi.fn(() => options.shortGate ?? { enabled: false }),
    getAegisEventRiskConfig: vi.fn(
      () =>
        options.eventRisk ?? {
          enabled: false,
          mode: 'NORMAL',
          enforce: false,
          manual_override_enabled: false,
          caution: {
            min_quality_score: 0.65,
            max_tail_risk_score: 0.45,
            require_btc_eth_confirmation: true,
          },
          risk_off: {
            min_quality_score: 0.75,
            max_tail_risk_score: 0.35,
            allow_only_a_plus: true,
          },
          manual_only: {
            block_new_entries: false,
          },
        },
    ),
    getAegisRegimeGuardConfig: vi.fn(
      () =>
        options.regimeGuard ?? {
          enabled: false,
          mode: 'SHADOW',
          source: 'HYBRID_HEURISTIC',
          allowWhen: [
            'MOMENTUM_UP',
            'MOMENTUM_DOWN',
            'BREAKOUT_UP',
            'BREAKOUT_DOWN',
            'TREND_UP',
            'TREND_DOWN',
          ],
          blockWhen: ['RISK_OFF', 'HIGH_VOL_RISK'],
          minConfidence: 0.6,
          maxSnapshotAgeSeconds: 900,
          requireBtcEthAlignmentForAlts: true,
          allowAltLongWhenBtcShort: false,
          allowAltShortWhenBtcLong: false,
          highTailRiskThreshold: 0.45,
          telemetry: {
            logAllEvaluations: false,
            includeInEntryMetadata: true,
          },
        },
    ),
    getAegisRegimeContextConfig: vi.fn(
      () =>
        options.regimeContext ?? {
          enabled: false,
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
            maxExhaustionScore: 0.6,
          },
        },
    ),
    getAegisMomentumRideConfig: vi.fn(
      () =>
        options.momentumRide ?? {
          enabled: false,
          mode: 'SHADOW',
          researchMode: false,
          regimeFilter: {
            enabled: false,
            useAsGate: false,
            recordMetadata: true,
            ignoreForEntry: true,
          },
          allowWhenAegisDenied: false,
          requireAegisDirectionConfirmation: true,
          allowMomentumAgainstAegis: false,
          requireBtcEthNotContradicting: true,
          requireBtcEthConfirmation: false,
          symbols: {},
          safetyCaps: {
            maxLeverage: 50,
            maxPositionFraction: 0.03,
            maxOpenMomentumPositions: 1,
            maxTotalOpenPositionsWhenMomentum: 2,
            maxMomentumTradesPerDay: 3,
            maxConsecutiveMomentumLosses: 2,
            cooldownAfterLossMinutes: 60,
            disableSymbolAfterStopLossMinutes: 120,
            requireBrackets: true,
            requireProfitProtection: true,
          },
        },
    ),
    getAegisDecisionEnforcementConfig: vi.fn(
      () =>
        options.decisionEnforcement ?? {
          enabled: false,
          mode: 'OFF',
          block_do_not_enter: false,
          block_wait_confirmation: false,
          block_manual_only: false,
          block_entry_quality_shadow_block_when_event_risk: {
            enabled: false,
            event_modes: [],
          },
          event_risk_enforcement: {
            caution_blocks_weak_entries: false,
            risk_off_blocks_non_a_plus: false,
            manual_only_blocks_all_new_entries: false,
          },
          block_caution_would_block_unless_a_plus: false,
          block_all_entry_quality_shadow_block: false,
          block_all_tail_risk_high: false,
        },
    ),
    getAegisTelegramNotificationsConfig: vi.fn(
      () =>
        options.telegramNotifications ?? {
          automatic_block_alerts_enabled: false,
          block_dedupe: {
            enabled: true,
            cooldown_minutes: 15,
            summary_threshold: 25,
            max_cache_entries: 1000,
            include_suppressed_count: true,
          },
        },
    ),
    getAegisProfitProtectionConfig: vi.fn(() => ({
      enabled: true,
      protect_profit_enabled: true,
      min_peak_roe_to_protect: 0.08,
      protect_giveback_roe: 0.05,
      min_locked_roe: 0.01,
      be_offset_pct: 0.003,
      immediate_trigger_buffer_pct: 0.001,
    })),
    getAegisPositionFractionOverride: vi.fn(() => options.positionFractionOverride),
    getAegisCleanEntryGuardConfig: vi.fn(
      () => options.cleanEntryGuard ?? cleanEntryGuardConfig({ enabled: false }),
    ),
    getAegisProbeModeConfig: vi.fn(
      () => options.probeMode ?? probeModeConfig({ enabled: false, mode: 'OFF' }),
    ),
    getEntryQualityGateConfig: vi.fn(() => options.entryQuality ?? entryQualityConfig()),
    getRegimeConfig: vi.fn(() => options.regime ?? regimeConfig()),
    getGuardianConfig: vi.fn(
      () =>
        options.guardian ?? {
          beTriggerRoe: (options.regime ?? regimeConfig()).beRoe ?? 0.1,
          beOffsetPct: 0.003,
          trailingDev: 0.015,
          trailingActivationRoe: (options.regime ?? regimeConfig()).trailingActivationRoe ?? 0.15,
          trailingCallbackRoe: (options.regime ?? regimeConfig()).trailingCallbackRoe ?? 0.08,
          useAtrTrailing: true,
          atrMultiplier: 1.5,
        },
    ),
    getSymbolMode: vi.fn((symbol: string) => symbolModes[symbol] ?? 'SHADOW'),
    getLiveAegisSymbols: vi.fn(() =>
      Object.entries(symbolModes)
        .filter(([, mode]) => mode === 'LIVE')
        .map(([symbol]) => symbol),
    ),
    getActiveAegisSymbols: vi.fn(() =>
      Object.entries(symbolModes)
        .filter(([, mode]) => mode !== 'OFF')
        .map(([symbol]) => symbol),
    ),
    validateSingleLiveAegisSymbol: vi.fn(),
    system: {},
    trading: { fee_buffer_pct: 0.05 },
  };
  if (options.entryPolicy) {
    configManager.getAegisEntryPolicyConfig = vi.fn(() => options.entryPolicy);
  }
  const historyLogger = {
    logSignal: vi.fn().mockResolvedValue(undefined),
    logTradeEvent: vi.fn().mockResolvedValue(undefined),
    logAccountSnapshot: vi.fn().mockResolvedValue(undefined),
    logTradeOpen: vi.fn().mockResolvedValue(undefined),
    logTradeClose: vi.fn().mockResolvedValue(undefined),
  };
  const mlService = {
    getSignal: vi.fn(async (symbol: string) => {
      if (options.signal) return options.signal;
      return withCanonicalDecision({ ...validSignal(), symbol }, true, 'LONG');
    }),
    getExitSignal: vi.fn(),
    checkHealth: vi.fn(),
  };
  const service = new TradingService(
    {
      exchange: exchange as any,
      mlService: mlService as any,
      logger,
      state,
      notifier,
      configManager: configManager as any,
      historyLogger: historyLogger as any,
      closedTradeOutcomeReader: vi.fn().mockResolvedValue(options.closedTradeOutcomes ?? []),
    },
    {
      symbols: options.symbols ?? ['ETHUSDT'],
      tickIntervalMs: 0,
      maxTradesPerDay: 100,
      tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
    },
  );
  // Entry tests must provide the same explicit fresh-liquidity evidence required by production.
  (service as any).detector = Object.fromEntries(
    (options.symbols ?? ['ETHUSDT']).map((symbol) => {
      const detector = new LiquidityVoidDetector(logger);
      detector.processDepthUpdate({
        bidDepth: Array.from({ length: 20 }, (_, index) => ({ price: 3000 - index, qty: 1 })),
        askDepth: Array.from({ length: 20 }, (_, index) => ({ price: 3000 + index, qty: 1 })),
        receivedAtMs: Date.now(),
      });
      return [symbol, detector];
    }),
  );

  return {
    exchange,
    historyLogger,
    logger,
    mlService,
    notifier,
    service,
    state,
    configManager,
    symbolStores,
  };
}

describe('TradingService Aegis live execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig(true);
  });

  afterEach(() => {
    restoreConfig();
  });

  it('includes current wallet balance in the startup Telegram message', async () => {
    const { exchange, notifier, service } = makeHarness({
      balance: 565.39,
      symbols: ['ETHUSDT', 'BTCUSDT'],
      symbolModes: { ETHUSDT: 'LIVE', BTCUSDT: 'LIVE' },
      momentumRide: momentumRideRuntimeConfig(0.02),
      probeMode: probeModeConfig({ enabled: true, mode: 'ENFORCE' }),
    });

    await service.start(false);

    expect(exchange.getUSDTBalance).toHaveBeenCalled();
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('🔥 AEGIS + MOMENTUM LIVE ✅'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('🧠 MICRO-LIVE | Live ON | Shorts OFF'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('🎯 Símbolos activos (2)\nETH BTC'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('💰 Wallet $565.39 | Equity $565.39 | Disp. $565.39'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('🛡️ Aegis Turbo'));
    expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('⚡ Momentum Ride'));
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Mode: ENFORCE | Prioridad: alta'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Max position: 2.0% wallet'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('🧭 RegimeEngineV2'));
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Metadata ON | Gate OFF'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('🧪 Probe Mode'));
    expect(notifier.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('Radar ETHUSDT'));
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('💼 Posiciones\nNinguna'),
    );
  });

  it('restores consecutive losses from the closed-trade journal at startup', async () => {
    const { service } = makeHarness({
      closedTradeOutcomes: [
        { tradeId: 'loss-1', closedAt: '2026-07-27T00:00:00.000Z', pnlUsdt: -2 },
        { tradeId: 'loss-2', closedAt: '2026-07-27T00:05:00.000Z', pnlUsdt: -1 },
        { tradeId: 'time-limit-profit', closedAt: '2026-07-27T00:10:00.000Z', pnlUsdt: 0.5 },
      ],
    });

    await service.start(false);

    expect(service.getAegisRuntimeSnapshot().consecutiveLosses).toBe(0);
    service.stop();
  });

  it('updates the streak once through the common confirmed-close path', async () => {
    const { service } = makeHarness();
    const botState = {
      mode: 'LONG_RIDE',
      positionOwner: 'AEGIS',
      tradeOrigin: 'BOT',
      ownershipStatus: 'VERIFIED',
      eligibleForBotMetrics: true,
      lastTradeId: 'confirmed-loss',
      lastEntryAt: Date.now() - 60_000,
      lastEntryPrice: 3000,
      lastEntryQty: 0.01,
      lastEntryMargin: 2,
      lastLeverage: 20,
      peakRoe: 0.01,
      lowestRoe: -0.1,
    };

    await (service as any).notifyExit('ETHUSDT', 'LONG', 'TRAILING_SAFETY_NET', botState, {
      exitPrice: 2985,
      finalRoe: -0.1,
      pnl: -1,
    });
    await (service as any).notifyExit('ETHUSDT', 'LONG', 'TRAILING_SAFETY_NET', botState, {
      exitPrice: 2985,
      finalRoe: -0.1,
      pnl: -1,
    });

    expect(service.getAegisRuntimeSnapshot().consecutiveLosses).toBe(1);
  });

  it('resets the streak when a TIME_LIMIT close is profitable', async () => {
    const { service } = makeHarness();
    (service as any).consecutiveLossTracker.restore([
      { tradeId: 'loss-1', closedAt: '2026-07-27T00:00:00.000Z', pnlUsdt: -2 },
      { tradeId: 'loss-2', closedAt: '2026-07-27T00:05:00.000Z', pnlUsdt: -1 },
    ]);
    const botState = {
      mode: 'SHORT_RIDE',
      positionOwner: 'AEGIS',
      tradeOrigin: 'BOT',
      ownershipStatus: 'VERIFIED',
      eligibleForBotMetrics: true,
      lastTradeId: 'time-limit-profit',
      lastEntryAt: Date.now() - 9 * 60 * 60 * 1000,
      lastEntryPrice: 3000,
      lastEntryQty: 0.01,
      lastEntryMargin: 2,
      lastLeverage: 20,
      peakRoe: 0.04,
      lowestRoe: -0.08,
    };

    await (service as any).notifyExit('ETHUSDT', 'SHORT', 'TIME_LIMIT', botState, {
      exitPrice: 2995,
      finalRoe: 0.03,
      pnl: 0.5,
    });

    expect(service.getAegisRuntimeSnapshot().consecutiveLosses).toBe(0);
  });

  it('does not journal or update the loss streak for a tainted close', async () => {
    const { historyLogger, service } = makeHarness();
    const taintedState = {
      mode: 'LONG_RIDE',
      positionOwner: 'AEGIS',
      tradeOrigin: 'BOT',
      ownershipStatus: 'TAINTED',
      eligibleForBotMetrics: false,
      metricsExclusionReason: 'EXTERNAL_QUANTITY_REDUCTION',
      lastTradeId: 'tainted-close',
      lastEntryAt: Date.now() - 60_000,
      lastEntryPrice: 3000,
      lastEntryQty: 0.01,
      lastEntryMargin: 2,
      lastLeverage: 20,
    };

    await (service as any).notifyExit('ETHUSDT', 'LONG', 'SL/TP', taintedState, {
      exitPrice: 2990,
      finalRoe: -0.1,
      pnl: -1,
    });

    expect(historyLogger.logTradeClose).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'TRADE_CLOSED' }),
    );
    expect(service.getAegisRuntimeSnapshot().consecutiveLosses).toBe(0);
  });

  it('does not invent realized PnL when only the close mark is known', async () => {
    const { historyLogger, service } = makeHarness();
    const botState = {
      mode: 'LONG_RIDE',
      positionOwner: 'AEGIS',
      tradeOrigin: 'BOT',
      ownershipStatus: 'VERIFIED',
      eligibleForBotMetrics: true,
      lastTradeId: 'unknown-close-pnl',
      lastEntryAt: Date.now() - 60_000,
      lastEntryPrice: 3000,
      lastEntryQty: 0.01,
      lastEntryMargin: 2,
      lastLeverage: 20,
    };

    await (service as any).notifyExit('ETHUSDT', 'LONG', 'TIME_LIMIT', botState, {
      exitPrice: 3010,
      finalRoe: 0.06,
    });

    expect(historyLogger.logTradeClose).toHaveBeenCalledWith(
      expect.not.objectContaining({ pnl_usdt: expect.anything() }),
    );
    expect(historyLogger.logTradeClose).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          pnl_status: 'UNKNOWN_EXACT_CLOSE_UNAVAILABLE',
          mark_price_close_reference: true,
        }),
      }),
    );
    expect(service.getAegisRuntimeSnapshot().consecutiveLosses).toBe(0);
  });

  it('includes approximate wallet balance with open unrealized PnL in the startup Telegram message', async () => {
    const { notifier, service } = makeHarness({
      balance: 500,
      markPrice: 2990,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 0.01,
        entryPrice: 3000,
        leverage: 20,
        isolatedMargin: 65,
        unrealizedPnl: -10,
      },
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 3000,
        lastEntryQty: 0.01,
        lastEntryMargin: 65,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 30 * 60 * 1000,
      },
    });

    await service.start(false);

    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('💰 Wallet $500.00 | Equity $500.00 | Disp. $500.00'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('💼 ETHUSDT LONG 📈'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('ROI -6.7% | PnL -$10.00 | 0.5h'),
    );
  });

  it('adopts a startup manual position with its exchange leverage and preserves existing brackets', async () => {
    const { exchange, historyLogger, logger, service, symbolStores } = makeHarness({
      symbolStates: { ETHUSDT: { mode: 'IDLE' } },
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 0.02,
        entryPrice: 3000,
        leverage: 40,
        isolatedMargin: 3,
      },
    });

    await service.start(false);

    expect(symbolStores.get('ETHUSDT')?.get().mode).toBe('LONG_RIDE');
    expect(symbolStores.get('ETHUSDT')?.get().positionOwner).toBe('EXTERNAL');
    expect(symbolStores.get('ETHUSDT')?.get().tradeOrigin).toBe('MANUAL_EXTERNAL');
    expect(symbolStores.get('ETHUSDT')?.get()).toEqual(
      expect.objectContaining({
        lastLeverage: 40,
        lastActualLeverage: 40,
        lastEntryQty: 0.02,
        lastEntryMargin: 3,
        posSideMode: 'LONG',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_manual_external_position_adopted',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        leverage: 40,
        ownership: 'MANUAL/EXTERNAL',
        action: 'MANAGE_GUARDS_AND_FILL_MISSING_BRACKETS',
      }),
    );
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(historyLogger.logTradeOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeClose).not.toHaveBeenCalled();
  });

  it('adds default -40% SL and +100% TP for an unprotected manual 40x position', async () => {
    const { exchange, service, symbolStores } = makeHarness({
      symbols: ['SIUUSDT'],
      symbolModes: { SIUUSDT: 'LIVE' },
      symbolStates: { SIUUSDT: { mode: 'IDLE' } },
      closeOrders: [],
      symbolFilters: {
        qtyPrecision: 0,
        pricePrecision: 4,
        minNotional: 5,
        tickSize: 0.0001,
        stepSize: 1,
      },
      regime: regimeConfig({ leverage: 20, hardStopRoe: -0.15, tpRoe: 0.25 }),
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 100,
        entryPrice: 0.753,
        leverage: 40,
        isolatedMargin: 1.8825,
      },
      markPrice: 0.753,
    });

    await service.start(false);

    expect(exchange.placeStopClose).toHaveBeenCalledTimes(1);
    expect(exchange.placeStopClose).toHaveBeenCalledWith('SIUUSDT', 'LONG', 0.7455);
    expect(exchange.placeTpClose).toHaveBeenCalledTimes(1);
    expect(exchange.placeTpClose).toHaveBeenCalledWith('SIUUSDT', 'LONG', 0.7718);
    expect(exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(symbolStores.get('SIUUSDT')?.get()).toEqual(
      expect.objectContaining({
        lastLeverage: 40,
        lastActualLeverage: 40,
        lastEntryQty: 100,
      }),
    );
  });

  it('recreates a deleted manual LONG stop at the persisted trailing ratchet', async () => {
    const { exchange, service, state } = makeHarness({
      preserveUnverifiedState: true,
      markPrice: 102,
      closeOrders: [{ orderId: 'manual-tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 105 }],
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      initialState: {
        mode: 'LONG_RIDE',
        positionOwner: 'EXTERNAL',
        tradeOrigin: 'MANUAL_EXTERNAL',
        ownershipStatus: 'UNKNOWN',
        eligibleForBotMetrics: false,
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryQty: 1,
        lastEntryAt: Date.now(),
        lastTrailStop: 101,
        lastStopPrice: 101,
        lastPeakPrice: 102,
        peakRoe: 0.4,
        lowestRoe: 0,
        lastTrailingActivationRoe: 9,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 101);
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(state.get()).toEqual(
      expect.objectContaining({ lastTrailStop: 101, lastStopPrice: 101 }),
    );
  });

  it('recreates a deleted manual SHORT stop at the persisted trailing ratchet', async () => {
    const { exchange, service, state } = makeHarness({
      preserveUnverifiedState: true,
      markPrice: 98,
      closeOrders: [{ orderId: 'manual-tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 95 }],
      readActivePosition: {
        sideMode: 'SHORT',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      initialState: {
        mode: 'SHORT_RIDE',
        positionOwner: 'EXTERNAL',
        tradeOrigin: 'MANUAL_EXTERNAL',
        ownershipStatus: 'UNKNOWN',
        eligibleForBotMetrics: false,
        lastSide: 'SHORT',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryQty: 1,
        lastEntryAt: Date.now(),
        lastTrailStop: 99,
        lastStopPrice: 99,
        lastPeakPrice: 98,
        peakRoe: 0.4,
        lowestRoe: 0,
        lastTrailingActivationRoe: 9,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'SHORT', 99);
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(state.get()).toEqual(expect.objectContaining({ lastTrailStop: 99, lastStopPrice: 99 }));
  });

  it('adopts a manual SHORT position at runtime when bot is IDLE', async () => {
    const { exchange, logger, service, state } = makeHarness({
      markPrice: 0.762,
      closeOrders: [{ orderId: 'manual-sl', type: 'STOP_MARKET', stopPrice: 0.78 }],
      initialState: {
        mode: 'IDLE',
        lastSide: 'LONG',
        lastEntryPrice: 0.753,
        lastExitReason: 'EXCLUDED_POSITION_NOW_FLAT',
      },
    });
    exchange.hasOpenPosition.mockResolvedValue(true);
    exchange.readActivePosition.mockImplementation((_sym: string, side: string) =>
      side === 'SHORT'
        ? Promise.resolve({
            sideMode: 'SHORT',
            qtyAbs: 100,
            entryPrice: 0.76,
            leverage: 40,
            isolatedMargin: 5,
          })
        : Promise.resolve(null),
    );

    await service.tick('ETHUSDT');

    expect(state.get()).toEqual(
      expect.objectContaining({
        mode: 'SHORT_RIDE',
        lastSide: 'SHORT',
        lastEntryPrice: 0.76,
        lastLeverage: 40,
        positionOwner: 'EXTERNAL',
        tradeOrigin: 'MANUAL_EXTERNAL',
        ownershipStatus: 'UNKNOWN',
      }),
    );
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_manual_position_adopted_runtime',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        side: 'SHORT',
      }),
    );
  });

  it('adopts a manual LONG position at runtime when bot is IDLE', async () => {
    const { exchange, logger, service, state } = makeHarness({
      markPrice: 104,
      closeOrders: [],
      initialState: {
        mode: 'IDLE',
        lastSide: 'SHORT',
        lastExitReason: 'EXCLUDED_POSITION_NOW_FLAT',
      },
    });
    exchange.hasOpenPosition.mockResolvedValue(true);
    exchange.readActivePosition.mockImplementation((_sym: string, side: string) =>
      side === 'LONG'
        ? Promise.resolve({
            sideMode: 'LONG',
            qtyAbs: 50,
            entryPrice: 105,
            leverage: 20,
            isolatedMargin: 10,
          })
        : Promise.resolve(null),
    );

    await service.tick('ETHUSDT');

    expect(state.get()).toEqual(
      expect.objectContaining({
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastEntryPrice: 105,
        lastLeverage: 20,
        positionOwner: 'EXTERNAL',
        tradeOrigin: 'MANUAL_EXTERNAL',
      }),
    );
    expect(exchange.placeStopClose).toHaveBeenCalled();
    expect(exchange.placeTpClose).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_manual_position_adopted_runtime',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        side: 'LONG',
      }),
    );
  });

  it('does not call lookForEntry when runtime adoption succeeds', async () => {
    const { exchange, service, state } = makeHarness({
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      markPrice: 101,
      closeOrders: [],
      initialState: { mode: 'IDLE' },
    });
    exchange.hasOpenPosition.mockResolvedValue(true);

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(state.get().mode).toBe('LONG_RIDE');
  });

  it('opens Aegis Turbo position with isolated margin and immediate brackets when env and YAML allow live', async () => {
    const { exchange, historyLogger, logger, notifier, service, state } = makeHarness();

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.ensureMarginType).toHaveBeenCalledWith('ETHUSDT', 'ISOLATED');
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 2970);
    expect(exchange.placeTpClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 3050);
    expect(exchange.setLeverage.mock.invocationCallOrder[0]).toBeLessThan(
      exchange.marketOpen.mock.invocationCallOrder[0],
    );
    expect(exchange.ensureMarginType.mock.invocationCallOrder[0]).toBeLessThan(
      exchange.marketOpen.mock.invocationCallOrder[0],
    );
    const entryStateSetOrder = state.set.mock.invocationCallOrder.find(
      (_: unknown, index: number) => state.set.mock.calls[index][0]?.lastBracketStatus === 'OK',
    )!;
    expect(exchange.placeStopClose.mock.invocationCallOrder[0]).toBeLessThan(entryStateSetOrder);
    expect(exchange.placeTpClose.mock.invocationCallOrder[0]).toBeLessThan(entryStateSetOrder);
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        positionOwner: 'BOT',
        tradeOrigin: 'BOT',
        ownershipStatus: 'VERIFIED',
        eligibleForBotMetrics: true,
        lastBracketStatus: 'OK',
        lastActualLeverage: 15,
        lastPositionFraction: 0.08,
        lastStopRoe: -0.15,
        lastTakeProfitRoe: 0.25,
        lastTrailingActivationRoe: 0.15,
        lastTrailingCallbackRoe: 0.08,
      }),
    );
    expect(historyLogger.logTradeOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'AEGIS',
        origin: 'BOT',
        ownership_status: 'VERIFIED',
        eligible_for_bot_metrics: true,
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_turbo_micro_live_entry',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        side: 'LONG',
        leverage: 15,
        positionFraction: 0.08,
      }),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('🔥 AEGIS TURBO ENTRY'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('ETHUSDT | 📈 LONG'));
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('SL: $2970.00 (-15.0% ROE)'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('TP: $3050.00 (+25.0% ROE)'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Score: 72.0% / 60.0%'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Equity total: $20.00'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('✅ Brackets confirmados'),
    );
  });

  it('keeps an Aegis-opened position attributed to Aegis when standalone Momentum is inactive', async () => {
    const { exchange, historyLogger, logger, service, state } = makeHarness({
      signal: signalWithRegimeContext({
        turboScore: 0.94,
        votes: { long: 3, short: 0, neutral: 0 },
      }),
      cachedCandles: momentumCandles(),
      momentumRide: momentumRideRuntimeConfig(0.015),
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.marketOpen).toHaveBeenCalledWith(
      'ETHUSDT',
      'LONG',
      expect.any(Number),
      expect.any(String),
    );
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastStrategy: 'AEGIS_TURBO',
        lastActualLeverage: 15,
      }),
    );
    expect(historyLogger.logTradeOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: 'AEGIS_TURBO',
        leverage: 15,
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_turbo_micro_live_entry',
      expect.objectContaining({
        finalStrategy: 'aegis_turbo',
        leverage: 15,
      }),
    );
  });

  it('enters on standalone momentum when Aegis signal is abstain/do-not-enter', async () => {
    const momentumCandlesList = Array.from({ length: 80 }, (_, index) => {
      const close = 100 + index * 0.01;
      const isMomentum = index >= 77;
      const open = isMomentum ? close - 0.2 : close - 0.05;
      return {
        openTime: index * 300_000,
        timestamp: index * 300_000,
        open,
        high: Math.max(open, close) + 0.1,
        low: Math.min(open, close) - 0.1,
        close,
        volume: isMomentum ? 120 + (index - 77) * 2 : 100,
        buyVolume: 50,
        closeTime: (index + 1) * 300_000 - 1,
      };
    });
    const abstainSignal: AegisTradingSignal = {
      symbol: 'ETHUSDT',
      action: 'PASS',
      confidence: 0,
      source: 'AEGIS_TURBO',
      longProb: 0.33,
      shortProb: 0.33,
      neutralProb: 0.34,
      metadata: {
        aegis: {
          turbo: {
            raw: { action: 'HOLD', turbo_score: 0.4, votes: { long: 0, short: 0, neutral: 3 } },
            gated: { action: 'HOLD', reason: 'abstain' },
          },
        },
      },
    };
    const config = momentumRideRuntimeConfig(0.02);
    config.standaloneMainReplica = true;
    config.aegisFallbackEnabled = false;

    const e4Evaluate = vi.spyOn(E4TailRiskGuardAdapter, 'evaluate');
    const { exchange, historyLogger, logger, mlService, service } = makeHarness({
      signal: abstainSignal,
      cachedCandles: momentumCandlesList,
      momentumRide: config,
    });

    vi.spyOn(
      (service as any).strategyRuntimeCoordinator,
      'readMomentumRealtimeMarket',
    ).mockReturnValue({
      source: 'SHARED_WEBSOCKET',
      status: 'FRESH',
      orderBookHealth: 'HEALTHY',
      observedAtMs: Date.now(),
      ageMs: 0,
      aggTradeAgeMs: 0,
      aggTradeGapFree: true,
      aggTradeCount: 10,
      netTakerVolume: 1,
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith(
      'ETHUSDT',
      'LONG',
      expect.any(Number),
      expect.any(String),
    );
    expect(historyLogger.logTradeOpen).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'MOMENTUM_RIDE', side: 'LONG' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'momentum_ride_live_entry',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        side: 'LONG',
        leverage: 30,
        positionFraction: 0.02,
      }),
    );
    expect(mlService.getSignal).not.toHaveBeenCalled();
    expect(e4Evaluate).not.toHaveBeenCalled();
  });

  it('blocks standalone Momentum on a shared account-wide daily-loss veto', async () => {
    const config = momentumRideRuntimeConfig(0.02);
    config.standaloneMainReplica = true;
    config.aegisFallbackEnabled = false;
    config.safetyCaps.dailyLossStopPct = 0.1;
    const loss = {
      tradeId: 'MOMENTUM-RIDE-LOSS',
      closedAt: new Date().toISOString(),
      pnlUsdt: -2,
    };
    const { exchange, historyLogger, service } = makeHarness({
      cachedCandles: Array.from({ length: 80 }, (_, index) => {
        const close = 100 + index * 0.01;
        const isMomentum = index >= 77;
        const open = isMomentum ? close - 0.2 : close - 0.05;
        return {
          openTime: index * 300_000,
          timestamp: index * 300_000,
          open,
          high: Math.max(open, close) + 0.1,
          low: Math.min(open, close) - 0.1,
          close,
          volume: isMomentum ? 120 + (index - 77) * 2 : 100,
          buyVolume: 50,
          closeTime: (index + 1) * 300_000 - 1,
        };
      }),
      momentumRide: config,
      closedTradeOutcomes: [loss],
    });

    vi.spyOn(
      (service as any).strategyRuntimeCoordinator,
      'readMomentumRealtimeMarket',
    ).mockReturnValue({
      source: 'SHARED_WEBSOCKET',
      status: 'FRESH',
      orderBookHealth: 'HEALTHY',
      observedAtMs: Date.now(),
      ageMs: 0,
      aggTradeAgeMs: 0,
      aggTradeGapFree: true,
      aggTradeCount: 10,
      netTakerVolume: 1,
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: 'MOMENTUM_RIDE',
        gate_allowed: false,
        reason: 'daily_loss_stop_reached',
      }),
    );
  });

  it('ignores non-momentum ticks when standalone momentum is active and no pattern exists', async () => {
    const regularCandles = Array.from({ length: 80 }, (_, index) => ({
      openTime: index * 300_000,
      timestamp: index * 300_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
      buyVolume: 50,
      closeTime: (index + 1) * 300_000 - 1,
    }));
    const abstainSignal: AegisTradingSignal = {
      symbol: 'ETHUSDT',
      action: 'PASS',
      confidence: 0,
      source: 'AEGIS_TURBO',
      longProb: 0.33,
      shortProb: 0.33,
      neutralProb: 0.34,
    };
    const config = momentumRideRuntimeConfig(0.02);
    config.standaloneMainReplica = true;
    config.aegisFallbackEnabled = false;

    const { exchange, service } = makeHarness({
      signal: abstainSignal,
      cachedCandles: regularCandles,
      momentumRide: config,
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
  });

  it('blocks before marketOpen when verified bot-only daily loss stop is reached', async () => {
    const { exchange, logger, service, state } = makeHarness({
      balance: 17.9,
      closedTradeOutcomes: [
        { tradeId: 'today-loss', closedAt: new Date().toISOString(), pnlUsdt: -2.1 },
      ],
    });
    (service as any).dailyStartBalance = 20;

    await service.tick('ETHUSDT');

    expect(logger.info).toHaveBeenCalledWith(
      'aegis_micro_live_gate_denied',
      expect.objectContaining({
        reason: 'daily_loss_stop_reached',
        balance: 17.9,
        dailyStartBalance: 20,
        dailyPnlPct: expect.any(Number),
        dailyPnlScope: 'VERIFIED_BOT_CLOSED_OUTCOMES',
        accountWideDailyPnlPct: expect.any(Number),
        dailyLossStopPct: 0.1,
      }),
    );
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.ensureMarginType).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
  });

  it('allows entry flow when daily loss is inside the limit', async () => {
    const { exchange, logger, service } = makeHarness({ balance: 19.2 });
    (service as any).dailyStartBalance = 20;

    await service.tick('ETHUSDT');

    expect(logger.info).not.toHaveBeenCalledWith(
      'aegis_micro_live_gate_denied',
      expect.objectContaining({
        reason: 'daily_loss_stop_reached',
      }),
    );
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
  });

  it('overrides ML position fraction for a configured LONG symbol before sizing the order', async () => {
    const { exchange, historyLogger, logger, service, state } = makeHarness({
      positionFractionOverride: {
        symbol: 'ETHUSDT',
        side: 'LONG',
        positionFraction: 0.1,
        ruleIndex: 0,
        ruleName: 'majors-example',
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.009, expect.any(String));
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastPositionFraction: 0.1,
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'POSITION_FRACTION_OVERRIDE_APPLIED',
        reason: 'configured_position_fraction_override',
        metadata: expect.objectContaining({
          symbol: 'ETHUSDT',
          side: 'LONG',
          mlPositionFraction: 0.08,
          overriddenPositionFraction: 0.1,
          ruleName: 'majors-example',
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_position_fraction_override_applied',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        side: 'LONG',
        mlPositionFraction: 0.08,
        overriddenPositionFraction: 0.1,
      }),
    );
  });

  it('clean entry guard SHADOW ignores legacy rule insufficient_data when Python model is ok', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      signal: validSignalWithDecisionBrain('ENTER_NOW', 'ALLOW_SHADOW'),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'SHADOW' }),
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'SHADOW',
      }),
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'CLEAN_ENTRY_GUARD_SHADOW_ALLOW',
        reason: 'clean_entry_allow',
        metadata: expect.objectContaining({
          cleanEntryGuard: expect.objectContaining({
            decision: 'ALLOW_CLEAN',
            allowed: true,
            wouldBlock: false,
            reasons: [],
            entryQualityRuleGateReason: 'INSUFFICIENT_DATA',
            clean_entry_rule_gate_insufficient_context_ignored_due_to_model_ok: true,
          }),
        }),
      }),
    );
  });

  it('clean entry guard ENFORCE does not block on legacy rule insufficient_data when Python model is ok', async () => {
    const { exchange, historyLogger, service, state } = makeHarness({
      signal: validSignalWithDecisionBrain('ENTER_NOW', 'ALLOW_SHADOW'),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'SHADOW',
      }),
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(state.set).toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'CLEAN_ENTRY_GUARD_ALLOW',
        reason: 'clean_entry_allow',
        metadata: expect.objectContaining({
          cleanEntryGuard: expect.objectContaining({
            decision: 'ALLOW_CLEAN',
            allowed: true,
            wouldBlock: false,
            reasons: [],
            entryQualityRuleGateReason: 'INSUFFICIENT_DATA',
            clean_entry_rule_gate_insufficient_context_ignored_due_to_model_ok: true,
          }),
        }),
      }),
    );
  });

  it('clean entry guard ENFORCE lets clean entries keep leverage sizing and brackets', async () => {
    const { exchange, historyLogger, service, state } = makeHarness({
      signal: validSignalWithDecisionBrain('ENTER_NOW', 'ALLOW_SHADOW'),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'SHADOW',
        config: {
          requireMomentumConfirm: false,
          antiFallingKnifeEnabled: false,
          overextensionEnabled: false,
          volatilityEnabled: false,
        },
      }),
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 2970);
    expect(exchange.placeTpClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 3050);
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastActualLeverage: 15,
        lastPositionFraction: 0.08,
        lastBracketStatus: 'OK',
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_ALLOWED',
        metadata: expect.objectContaining({
          cleanEntryGuard: expect.objectContaining({
            decision: 'ALLOW_CLEAN',
            clean: true,
            dirty: false,
          }),
          positionFraction: 0.08,
          leverage: 15,
        }),
      }),
    );
    expect(historyLogger.logTradeOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        leverage: 15,
        position_fraction: 0.08,
        metadata: expect.objectContaining({
          cleanEntryGuard: expect.objectContaining({
            decision: 'ALLOW_CLEAN',
          }),
        }),
      }),
    );
  });

  it('Probe Mode allows CAUTION setup when CleanEntry only blocks on EventRisk', async () => {
    const signal = probeSignal({ symbol: 'ADAUSDT' });
    const aegis = signal.metadata!.aegis as any;
    aegis.event_risk_auto.btc_context = { action: 'LONG', score: 0.72 };
    aegis.event_risk_auto.eth_context = { action: 'LONG', score: 0.71 };
    const { exchange, historyLogger, notifier, service, state } = makeHarness({
      symbols: ['ADAUSDT'],
      symbolModes: { ADAUSDT: 'LIVE' },
      signal,
      eventRisk: {
        enabled: true,
        mode: 'CAUTION',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: { min_quality_score: 0.75, max_tail_risk_score: 0.35, allow_only_a_plus: true },
        manual_only: { block_new_entries: false },
      },
      decisionEnforcement: decisionEnforcementConfig(),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      probeMode: probeModeConfig(),
    });

    await service.tick('ADAUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ADAUSDT', 'LONG', 0.007, expect.any(String));
    expect(exchange.placeStopClose).toHaveBeenCalled();
    expect(exchange.placeTpClose).toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROBE_MODE_ALLOWED',
        reason: 'probe_allowed',
        metadata: expect.objectContaining({
          probeMode: expect.objectContaining({
            allowed: true,
            eventRiskMode: 'CAUTION',
            cleanEntryReasons: ['clean_entry_event_risk_would_block'],
          }),
        }),
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_ALLOWED',
        metadata: expect.objectContaining({
          probeMode: expect.objectContaining({ allowed: true }),
        }),
      }),
    );
    expect(historyLogger.logTradeOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          probeMode: expect.objectContaining({ allowed: true }),
          cleanEntryGuard: expect.objectContaining({ decision: 'WAIT_CONFIRMATION' }),
        }),
      }),
    );
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        probeModeActive: true,
        lastProbeTradeId: expect.any(String),
      }),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('🧪 Probe Mode permitió entrada'),
    );
  });

  it('does not execute orders when Probe LONG is blocked by LongRiskShadow CRITICAL', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['ADAUSDT'],
      symbolModes: { ADAUSDT: 'LIVE' },
      signal: probeSignal({ symbol: 'ADAUSDT' }),
      cachedCandles: cachedCandles([
        1.05, 1.04, 1.03, 1.02, 1.01, 1.0, 0.995, 0.99, 0.985, 0.98, 0.975, 0.97, 0.965, 0.96,
      ]),
      eventRisk: {
        enabled: true,
        mode: 'CAUTION',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: { min_quality_score: 0.75, max_tail_risk_score: 0.35, allow_only_a_plus: true },
        manual_only: { block_new_entries: false },
      },
      decisionEnforcement: decisionEnforcementConfig(),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      probeMode: probeModeConfig(),
      entryPolicy: {
        enabled: true,
        guards: {
          regime_context: { enabled: false, mode: 'OFF' },
          regime: { enabled: true, mode: 'SHADOW' },
          short_gate: { enabled: false, mode: 'OFF' },
          entry_quality: { enabled: true, mode: 'ENFORCE' },
          event_risk: { enabled: true, mode: 'ENFORCE' },
          decision_brain: { enabled: true, mode: 'ENFORCE' },
          clean_entry: { enabled: true, mode: 'ENFORCE' },
          probe_mode: { enabled: true, mode: 'ENFORCE' },
          long_risk_shadow: {
            enabled: true,
            mode: 'ENFORCE_PROBE_LONG_CRITICAL',
            probeLongCriticalAction: 'BLOCK',
            probeLongHighAction: 'SHADOW',
            aegisLongCriticalAction: 'SHADOW',
            minRiskLevelToBlockProbe: 'CRITICAL',
            blockOnlyProbeMode: true,
            blockOnlyLong: true,
          },
        },
      },
    });

    await service.tick('ADAUSDT');

    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.ensureMarginType).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'long_risk_probe_long_critical',
        metadata: expect.objectContaining({
          finalDecision: 'DENY',
          finalReason: 'long_risk_probe_long_critical',
          finalStrategy: 'none',
          longRiskShadow: expect.objectContaining({
            riskLevel: 'CRITICAL',
            enforcementApplied: true,
            blockedProbeLong: true,
            actionTaken: 'BLOCK',
          }),
        }),
      }),
    );
    expect(historyLogger.logSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        executed: false,
        gate_reason: 'long_risk_probe_long_critical',
      }),
    );
  });

  it('Probe Mode denial leaves ProfitProtection ExitEye and brackets untouched', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['ADAUSDT'],
      symbolModes: { ADAUSDT: 'LIVE' },
      signal: probeSignal({ symbol: 'ADAUSDT', tailRiskScore: 0.31 }),
      eventRisk: {
        enabled: true,
        mode: 'CAUTION',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: { min_quality_score: 0.75, max_tail_risk_score: 0.35, allow_only_a_plus: true },
        manual_only: { block_new_entries: false },
      },
      decisionEnforcement: decisionEnforcementConfig(),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      probeMode: probeModeConfig(),
    });

    await service.tick('ADAUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROBE_MODE_DENIED',
        reason: 'probe_tail_risk_too_high',
        metadata: expect.objectContaining({
          probeMode: expect.objectContaining({ allowed: false }),
        }),
      }),
    );
  });

  it('canonical current brain blocks a non-entry decision before Probe Mode', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['ADAUSDT'],
      symbolModes: { ADAUSDT: 'LIVE' },
      signal: probeSignal({ symbol: 'ADAUSDT', decision: 'MANUAL_ONLY' }),
      eventRisk: {
        enabled: true,
        mode: 'CAUTION',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: { min_quality_score: 0.75, max_tail_risk_score: 0.35, allow_only_a_plus: true },
        manual_only: { block_new_entries: false },
      },
      decisionEnforcement: decisionEnforcementConfig(),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      probeMode: probeModeConfig(),
    });

    await service.tick('ADAUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_DENIED',
        reason: 'current_brain_canonical_do_not_enter',
      }),
    );
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROBE_MODE_DENIED',
      }),
    );
  });

  it('canonical current brain DO_NOT_ENTER blocks before Probe Mode', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['ADAUSDT'],
      symbolModes: { ADAUSDT: 'LIVE' },
      signal: probeSignal({ symbol: 'ADAUSDT', decision: 'DO_NOT_ENTER' }),
      eventRisk: {
        enabled: true,
        mode: 'CAUTION',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: { min_quality_score: 0.75, max_tail_risk_score: 0.35, allow_only_a_plus: true },
        manual_only: { block_new_entries: false },
      },
      decisionEnforcement: decisionEnforcementConfig(),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      probeMode: probeModeConfig(),
    });

    await service.tick('ADAUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_DENIED',
        reason: 'current_brain_canonical_do_not_enter',
      }),
    );
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROBE_MODE_DENIED',
      }),
    );
  });

  it('Probe Mode records denied when EntryQuality BLOCK_SHADOW blocks before CleanEntry', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['ADAUSDT'],
      symbolModes: { ADAUSDT: 'LIVE' },
      signal: probeSignal({ symbol: 'ADAUSDT', entryQualityRecommendation: 'BLOCK_SHADOW' }),
      eventRisk: {
        enabled: true,
        mode: 'CAUTION',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: { min_quality_score: 0.75, max_tail_risk_score: 0.35, allow_only_a_plus: true },
        manual_only: { block_new_entries: false },
      },
      decisionEnforcement: decisionEnforcementConfig(),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      probeMode: probeModeConfig(),
    });

    await service.tick('ADAUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
        reason: 'entry_quality_shadow_block_hard_denied',
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROBE_MODE_DENIED',
        reason: 'probe_entry_quality_block_shadow',
        metadata: expect.objectContaining({
          probeMode: expect.objectContaining({
            allowed: false,
            entryQualityRecommendation: 'BLOCK_SHADOW',
          }),
        }),
      }),
    );
  });

  it('Probe Mode records denied when RISK_OFF blocks before CleanEntry', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['ADAUSDT'],
      symbolModes: { ADAUSDT: 'LIVE' },
      signal: probeSignal({ symbol: 'ADAUSDT', tailRiskScore: 0.36 }),
      eventRisk: {
        enabled: true,
        mode: 'RISK_OFF',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: { min_quality_score: 0.75, max_tail_risk_score: 0.35, allow_only_a_plus: true },
        manual_only: { block_new_entries: false },
      },
      decisionEnforcement: decisionEnforcementConfig(),
      cleanEntryGuard: cleanEntryGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      probeMode: probeModeConfig(),
    });

    await service.tick('ADAUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
        reason: 'event_risk_risk_off_denied_non_a_plus',
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROBE_MODE_DENIED',
        reason: 'probe_event_risk_risk_off',
        metadata: expect.objectContaining({
          probeMode: expect.objectContaining({
            allowed: false,
            eventRiskMode: 'RISK_OFF',
          }),
        }),
      }),
    );
  });

  it('does not treat isolated margin usage as daily loss when equity is unchanged', async () => {
    const { exchange, logger, service } = makeHarness({
      balance: 15,
      accountSnapshot: {
        walletBalance: 20,
        availableBalance: 15,
        equityTotal: 20,
      },
    });
    (service as any).dailyStartBalance = 20;

    await service.tick('ETHUSDT');

    expect(logger.info).not.toHaveBeenCalledWith(
      'aegis_micro_live_gate_denied',
      expect.objectContaining({
        reason: 'daily_loss_stop_reached',
      }),
    );
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.005, expect.any(String));
  });

  it('retries readActivePosition after marketOpen until the position is confirmed', async () => {
    const position = {
      sideMode: 'LONG',
      qtyAbs: 0.01,
      entryPrice: 3000,
      leverage: 20,
      isolatedMargin: 2,
    };
    const { exchange, service } = makeHarness({
      readActivePositionSequence: [null, null, position],
    });

    await service.tick('ETHUSDT');

    expect(exchange.readActivePosition).toHaveBeenCalledTimes(3);
    expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 2970);
    expect(exchange.placeTpClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 3050);
  });

  it('does not blindly close when position cannot be verified after marketOpen', async () => {
    const { exchange, logger, service, state } = makeHarness({
      readActivePositionSequence: [null, null, null, null, null],
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalled();
    expect(exchange.readActivePosition).toHaveBeenCalledTimes(6);
    expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalledWith(
      expect.objectContaining({
        currentRegime: 'AEGIS_TURBO',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'aegis_position_verify_failed_after_market_open',
      expect.any(Object),
    );
  });

  it('alerts if emergency close fails after verify failed', async () => {
    const { exchange, logger, notifier, service, state } = makeHarness({
      readActivePositionSequence: [null, null, null, null, null],
      closeSideMarketSafeReject: true,
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalledWith(
      'shared_strategy_execution_emergency_close_failed',
      expect.any(Object),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('⚠️ **AEGIS EMERGENCY CLOSE'),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('AEGIS_POSITION_VERIFY_FAILED'),
    );
    expect(state.get()).toEqual(expect.objectContaining({ mode: 'IDLE' }));
  });

  it('closes immediately when bracket validation fails', async () => {
    const { exchange, logger, service, state } = makeHarness({
      closeOrders: [],
      readActivePositionSequence: [
        null,
        { sideMode: 'LONG', qtyAbs: 0.01, entryPrice: 3000, leverage: 20, isolatedMargin: 2 },
        { sideMode: 'LONG', qtyAbs: 0.01, entryPrice: 3000, leverage: 20, isolatedMargin: 2 },
        null,
      ],
    });

    await service.tick('ETHUSDT');

    expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith(
      'ETHUSDT',
      'LONG',
      0.01,
      'LONG',
      'AEGIS_BRACKET_FAILED',
    );
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'IDLE',
        lastExitReason: 'AEGIS_BRACKET_FAILED',
        lastBracketStatus: 'FAILED_CLOSED',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'aegis_bracket_validation_failed',
      expect.any(Object),
    );
  });

  it('does not open when AEGIS_LIVE_ENABLED=false', async () => {
    const { exchange, logger, service } = makeHarness({ liveEnabled: false });

    await service.tick('ETHUSDT');

    expect(logger.info).toHaveBeenCalledWith(
      'aegis_micro_live_gate_denied',
      expect.objectContaining({
        reason: 'aegis_live_disabled',
      }),
    );
    expect(exchange.marketOpen).not.toHaveBeenCalled();
  });

  it('scans a SHADOW symbol without live exchange execution or state mutation', async () => {
    const { exchange, historyLogger, service, state } = makeHarness({
      symbols: ['ETHUSDT', 'BTCUSDT'],
      symbolModes: { ETHUSDT: 'LIVE', BTCUSDT: 'SHADOW' },
    });

    await service.tick('BTCUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.ensureMarginType).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
    expect(historyLogger.logSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        executed: false,
        metadata: expect.objectContaining({ shadow_only: true }),
      }),
    );
  });

  it('does not manage the global ETH BotState while scanning a SHADOW BTC symbol', async () => {
    const { exchange, service, state } = makeHarness({
      symbols: ['ETHUSDT', 'BTCUSDT'],
      symbolModes: { ETHUSDT: 'LIVE', BTCUSDT: 'SHADOW' },
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 3000,
        lastLeverage: 20,
        lastEntryAt: Date.now(),
        lastPeakPrice: 3000,
      },
    });

    await service.tick('BTCUSDT');

    expect(exchange.readActivePosition).not.toHaveBeenCalledWith('BTCUSDT', 'LONG');
    expect(state.set).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'IDLE' }));
  });

  it('allows a LIVE BTC entry while ETH has its own active symbol state', async () => {
    const { exchange, logger, service } = makeHarness({
      symbols: ['ETHUSDT', 'BTCUSDT'],
      symbolModes: { ETHUSDT: 'LIVE', BTCUSDT: 'LIVE' },
      symbolStates: {
        ETHUSDT: {
          mode: 'LONG_RIDE',
          currentRegime: 'AEGIS_TURBO',
          lastStrategy: 'AEGIS_TURBO',
          lastSide: 'LONG',
          lastEntryPrice: 3000,
          lastLeverage: 20,
          lastEntryAt: Date.now(),
          lastPeakPrice: 3000,
        },
        BTCUSDT: {
          mode: 'IDLE',
          currentRegime: 'AEGIS_TURBO',
          lastExitAt: Date.now() - 20 * 60 * 1000,
        },
      },
    });

    await service.tick('BTCUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('BTCUSDT', 'LONG', 0.007, expect.any(String));
    expect(logger.warn).not.toHaveBeenCalledWith(
      'aegis_skip_manage_position_global_state_symbol_mismatch',
      expect.anything(),
    );
  });

  it('does not open when YAML live is disabled', async () => {
    const { exchange, logger, service } = makeHarness({ yaml: yamlTurbo({ live_enabled: false }) });

    await service.tick('ETHUSDT');

    expect(logger.info).toHaveBeenCalledWith(
      'aegis_micro_live_gate_denied',
      expect.objectContaining({
        reason: 'aegis_turbo_yaml_live_disabled',
      }),
    );
    expect(exchange.marketOpen).not.toHaveBeenCalled();
  });

  it('does not open if position is too small', async () => {
    const { exchange, logger, service } = makeHarness({ balance: 1 });

    await service.tick('ETHUSDT');

    expect(logger.warn).toHaveBeenCalledWith('aegis_position_too_small', expect.any(Object));
    expect(exchange.marketOpen).not.toHaveBeenCalled();
  });

  it('does not reinterpret a canonical SHORT through a legacy score threshold', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['BTCUSDT'],
      symbolModes: { BTCUSDT: 'LIVE' },
      signal: shortSignal('BTCUSDT', 0.79, 3),
      yaml: yamlTurbo({ allow_short: true }),
      shortGate: {
        enabled: true,
        position_fraction_multiplier: 1.0,
        max_leverage: 10,
        block_symbols: [],
      },
    });

    await service.tick('BTCUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('BTCUSDT', 10);
    expect(exchange.marketOpen).toHaveBeenCalledWith('BTCUSDT', 'SHORT', 0.005, expect.any(String));
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'SHORT_GATE_DENIED',
      }),
    );
  });

  it('accepts the single real directional estimator without fabricating votes', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['BTCUSDT'],
      symbolModes: { BTCUSDT: 'LIVE' },
      signal: shortSignal('BTCUSDT', 0.84, 1),
      yaml: yamlTurbo({ allow_short: true }),
      shortGate: {
        enabled: true,
        position_fraction_multiplier: 1.0,
        max_leverage: 10,
        block_symbols: [],
      },
    });

    await service.tick('BTCUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('BTCUSDT', 10);
    expect(exchange.marketOpen).toHaveBeenCalledWith('BTCUSDT', 'SHORT', 0.005, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'SHORT_GATE_ADJUSTED',
        reason: 'short_allowed_current_brain_canonical',
      }),
    );
  });

  it('uses adjusted leverage and preserves position fraction when SHORT premium passes', async () => {
    const { exchange, historyLogger, logger, service, state } = makeHarness({
      symbols: ['BTCUSDT'],
      symbolModes: { BTCUSDT: 'LIVE' },
      signal: shortSignal('BTCUSDT', 0.84, 3),
      yaml: yamlTurbo({ allow_short: true }),
      shortGate: {
        enabled: true,
        position_fraction_multiplier: 1.0,
        max_leverage: 10,
        block_symbols: [],
      },
    });

    await service.tick('BTCUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('BTCUSDT', 10);
    expect(exchange.marketOpen).toHaveBeenCalledWith('BTCUSDT', 'SHORT', 0.005, expect.any(String));
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastRequestedLeverage: 10,
        lastActualLeverage: 10,
        lastPositionFraction: 0.08,
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'SHORT_GATE_ADJUSTED',
        metadata: expect.objectContaining({
          originalLeverage: 15,
          adjustedLeverage: 10,
          originalPositionFraction: 0.08,
          adjustedPositionFraction: 0.08,
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_short_gate_adjusted',
      expect.objectContaining({
        symbol: 'BTCUSDT',
        adjustedLeverage: 10,
        adjustedPositionFraction: 0.08,
      }),
    );
  });

  it('overrides ML position fraction for SHORT before short gate leverage adjustment', async () => {
    const { exchange, historyLogger, service, state } = makeHarness({
      symbols: ['BTCUSDT'],
      symbolModes: { BTCUSDT: 'LIVE' },
      signal: shortSignal('BTCUSDT', 0.84, 3),
      yaml: yamlTurbo({ allow_short: true }),
      shortGate: {
        enabled: true,
        position_fraction_multiplier: 1.0,
        max_leverage: 10,
        block_symbols: [],
      },
      positionFractionOverride: {
        symbol: 'BTCUSDT',
        side: 'SHORT',
        positionFraction: 0.06,
        ruleIndex: 1,
        ruleName: 'majors-example',
      },
    });

    await service.tick('BTCUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('BTCUSDT', 10);
    expect(exchange.marketOpen).toHaveBeenCalledWith('BTCUSDT', 'SHORT', 0.003, expect.any(String));
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastPositionFraction: 0.06,
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'SHORT_GATE_ADJUSTED',
        metadata: expect.objectContaining({
          originalPositionFraction: 0.06,
          adjustedPositionFraction: 0.06,
        }),
      }),
    );
  });

  it('does not block a SHORT symbol when block_symbols is empty', async () => {
    const { exchange, service } = makeHarness({
      symbols: ['AVAXUSDT'],
      symbolModes: { AVAXUSDT: 'LIVE' },
      signal: shortSignal('AVAXUSDT', 0.91, 3),
      yaml: yamlTurbo({ allow_short: true }),
      shortGate: {
        enabled: true,
        position_fraction_multiplier: 1.0,
        max_leverage: 10,
        block_symbols: [],
      },
    });

    await service.tick('AVAXUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith(
      'AVAXUSDT',
      'SHORT',
      0.005,
      expect.any(String),
    );
  });

  it('blocks by portfolio cap before marketOpen', async () => {
    const { exchange, historyLogger, logger, service } = makeHarness({
      portfolioRisk: {
        enabled: true,
        max_open_positions: 0,
        max_same_direction_positions: 3,
        max_margin_used_pct: 0.45,
        max_notional_to_equity: 10,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.ensureMarginType).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PORTFOLIO_RISK_DENIED',
        reason: 'max_open_positions_reached',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_portfolio_risk_denied',
      expect.objectContaining({
        reason: 'max_open_positions_reached',
      }),
    );
  });

  it('keeps LONG entry working when portfolio risk allows', async () => {
    const position = {
      sideMode: 'LONG',
      qtyAbs: 0.01,
      entryPrice: 3000,
      leverage: 20,
      isolatedMargin: 2,
    };
    const { exchange, service } = makeHarness({
      readActivePositionSequence: [null, null, position],
      portfolioRisk: {
        enabled: true,
        max_open_positions: 4,
        max_same_direction_positions: 3,
        max_margin_used_pct: 0.45,
        max_notional_to_equity: 10,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.ensureMarginType).toHaveBeenCalledWith('ETHUSDT', 'ISOLATED');
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
  });

  it('portfolio_risk.enabled=false allows entry despite restrictive limits', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      portfolioRisk: {
        enabled: false,
        max_open_positions: 0,
        max_same_direction_positions: 0,
        max_margin_used_pct: 0.01,
        max_notional_to_equity: 0.01,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PORTFOLIO_RISK_DENIED',
      }),
    );
  });

  it('LONG is not affected by enabled short gate', async () => {
    const { exchange, service } = makeHarness({
      shortGate: {
        enabled: true,
        position_fraction_multiplier: 1.0,
        max_leverage: 10,
        block_symbols: ['ETHUSDT'],
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
  });

  it('in SHADOW, ENTRY_QUALITY_GATE_SHADOW_BLOCK does not prevent marketOpen', async () => {
    const { exchange, historyLogger, logger, service } = makeHarness({
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'SHADOW',
        config: { minScoreLong: 0.9 },
      }),
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_QUALITY_GATE_SHADOW_BLOCK',
        reason: 'score_below_entry_quality_threshold',
        metadata: expect.objectContaining({
          action: 'SHADOW_BLOCK',
          shadowDidNotBlock: true,
        }),
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'aegis_entry_quality_shadow_block',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        reason: 'score_below_entry_quality_threshold',
      }),
    );
  });

  it('entry_policy ENFORCE does not convert legacy EntryQuality SHADOW into marketOpen denial', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'SHADOW',
        config: { minScoreLong: 0.9 },
      }),
      entryPolicy: {
        enabled: true,
        guards: {
          short_gate: { enabled: false, mode: 'OFF' },
          entry_quality: { enabled: true, mode: 'ENFORCE' },
          event_risk: { enabled: false, mode: 'OFF' },
          decision_brain: { enabled: false, mode: 'OFF' },
          clean_entry: { enabled: false, mode: 'OFF' },
          probe_mode: { enabled: false, mode: 'OFF' },
        },
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'all_enforced_guards_allowed',
        metadata: expect.objectContaining({
          finalDecision: 'ALLOW',
          guards: expect.objectContaining({
            entry_quality: expect.objectContaining({
              mode: 'SHADOW',
              enforced: false,
              wouldBlock: true,
            }),
          }),
        }),
      }),
    );
  });

  it('Regime ENFORCE deny blocks before exchange mutation and records ENTRY_POLICY_DECISION', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['ADAUSDT'],
      symbolModes: { ADAUSDT: 'LIVE' },
      signal: signalWithRegimeContext({ symbol: 'ADAUSDT', btcAction: 'SHORT', ethAction: 'LONG' }),
      regimeGuard: regimeGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      entryPolicy: entryPolicyWithRegime('ENFORCE'),
    });

    await service.tick('ADAUSDT');

    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.ensureMarginType).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'regime_alt_long_btc_short_block',
        metadata: expect.objectContaining({
          finalDecision: 'DENY',
          finalReason: 'regime_alt_long_btc_short_block',
          regime: expect.objectContaining({
            regime: 'RISK_OFF',
            wouldBlock: true,
            source: 'HYBRID_HEURISTIC',
          }),
        }),
      }),
    );
  });

  it('Regime SHADOW_DENY does not block by itself and keeps metadata', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['ADAUSDT'],
      symbolModes: { ADAUSDT: 'LIVE' },
      signal: signalWithRegimeContext({ symbol: 'ADAUSDT', btcAction: 'SHORT', ethAction: 'LONG' }),
      regimeGuard: regimeGuardConfig({ enabled: true, mode: 'SHADOW' }),
      entryPolicy: entryPolicyWithRegime('SHADOW'),
    });

    await service.tick('ADAUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ADAUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'all_enforced_guards_allowed',
        metadata: expect.objectContaining({
          finalDecision: 'ALLOW',
          regime: expect.objectContaining({
            decision: 'SHADOW_DENY',
            wouldBlock: true,
            reason: 'regime_shadow_would_block',
          }),
        }),
      }),
    );
  });

  it('Regime ALLOW in ENFORCE continues normal flow', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      signal: signalWithRegimeContext(),
      regimeGuard: regimeGuardConfig({ enabled: true, mode: 'ENFORCE' }),
      entryPolicy: entryPolicyWithRegime('ENFORCE'),
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_POLICY_DECISION',
        metadata: expect.objectContaining({
          regime: expect.objectContaining({
            regime: 'MOMENTUM_UP',
            decision: 'ALLOW',
          }),
        }),
      }),
    );
  });

  it('in ENFORCE, ENTRY_QUALITY_GATE_DENIED prevents marketOpen', async () => {
    const { exchange, historyLogger, logger, service } = makeHarness({
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'ENFORCE',
        config: { minScoreLong: 0.9 },
      }),
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.ensureMarginType).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_QUALITY_GATE_DENIED',
        reason: 'score_below_entry_quality_threshold',
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'aegis_entry_quality_denied',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        reason: 'score_below_entry_quality_threshold',
      }),
    );
  });

  it('records history event in SHADOW', async () => {
    const { historyLogger, service } = makeHarness({
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'SHADOW',
        config: {
          requireMomentumConfirm: false,
          antiFallingKnifeEnabled: false,
          overextensionEnabled: false,
          volatilityEnabled: false,
        },
      }),
    });

    await service.tick('ETHUSDT');

    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_QUALITY_GATE_SHADOW_ALLOW',
        reason: 'entry_quality_passed',
        metadata: expect.objectContaining({
          symbol: 'ETHUSDT',
          side: 'LONG',
          mode: 'SHADOW',
        }),
      }),
    );
  });

  it('event risk enforce=false nunca impide marketOpen', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      eventRisk: {
        enabled: true,
        mode: 'MANUAL_ONLY',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: {
          min_quality_score: 0.75,
          max_tail_risk_score: 0.35,
          allow_only_a_plus: true,
        },
        manual_only: {
          block_new_entries: true,
        },
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'EVENT_RISK_SHADOW_BLOCK',
        reason: 'manual_only_requires_approval',
        metadata: expect.objectContaining({
          mode: 'MANUAL_ONLY',
          enforce: false,
          shadowDidNotBlock: true,
        }),
      }),
    );
  });

  it('event risk enforce=true manual_only impide marketOpen', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      eventRisk: {
        enabled: true,
        mode: 'MANUAL_ONLY',
        enforce: true,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: {
          min_quality_score: 0.75,
          max_tail_risk_score: 0.35,
          allow_only_a_plus: true,
        },
        manual_only: {
          block_new_entries: true,
        },
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.ensureMarginType).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'EVENT_RISK_DENIED',
        reason: 'manual_only_requires_approval',
      }),
    );
  });

  it('event risk registra evento allow en LONG normal', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      eventRisk: {
        enabled: true,
        mode: 'NORMAL',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: true,
        },
        risk_off: {
          min_quality_score: 0.75,
          max_tail_risk_score: 0.35,
          allow_only_a_plus: true,
        },
        manual_only: {
          block_new_entries: false,
        },
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'EVENT_RISK_SHADOW_ALLOW',
        reason: 'event_risk_normal',
        metadata: expect.objectContaining({
          symbol: 'ETHUSDT',
          side: 'LONG',
          mode: 'NORMAL',
        }),
      }),
    );
  });

  it('LONG limpio sigue normal', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'SHADOW',
        config: {
          requireMomentumConfirm: false,
          antiFallingKnifeEnabled: false,
          overextensionEnabled: false,
          volatilityEnabled: false,
        },
      }),
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_QUALITY_GATE_SHADOW_ALLOW',
      }),
    );
  });

  it('SHORT limpio sigue pasando por ShortGate y EntryQualityGate', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['BTCUSDT'],
      symbolModes: { BTCUSDT: 'LIVE' },
      signal: shortSignal('BTCUSDT', 0.84, 3),
      yaml: yamlTurbo({ allow_short: true }),
      shortGate: {
        enabled: true,
        position_fraction_multiplier: 1.0,
        max_leverage: 10,
        block_symbols: [],
      },
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'SHADOW',
        config: {
          requireMomentumConfirm: false,
          antiFallingKnifeEnabled: false,
          overextensionEnabled: false,
          volatilityEnabled: false,
        },
      }),
    });

    await service.tick('BTCUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('BTCUSDT', 10);
    expect(exchange.marketOpen).toHaveBeenCalledWith('BTCUSDT', 'SHORT', 0.005, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'SHORT_GATE_ADJUSTED',
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ENTRY_QUALITY_GATE_SHADOW_ALLOW',
        metadata: expect.objectContaining({ side: 'SHORT' }),
      }),
    );
  });

  it('does not call Binance REST candles to calculate entry quality gate', async () => {
    const { exchange, service } = makeHarness({
      entryQuality: entryQualityConfig({
        enabled: true,
        mode: 'SHADOW',
        config: { minScoreLong: 0.9 },
      }),
      cachedCandles: cachedCandles([100, 100.1, 100.2, 100.3]),
    });

    await service.tick('ETHUSDT');

    expect(exchange.getCachedCandles).toHaveBeenCalledWith('ETHUSDT', '5m', 160);
    expect(exchange.getCandles).not.toHaveBeenCalled();
    expect(exchange.marketOpen).toHaveBeenCalled();
  });

  it('excludes an identifiable open 5m candle from technical entry context', () => {
    const now = 1_800_000_000_000;
    const closed = {
      openTime: now - 10 * 60 * 1000,
      timestamp: now - 10 * 60 * 1000,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 100,
    };
    const open = {
      ...closed,
      openTime: now - 60 * 1000,
      timestamp: now - 60 * 1000,
      close: 200,
    };
    const { exchange, service } = makeHarness({ cachedCandles: [closed, open] });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    try {
      const context = (service as any).buildEntryQualityMarketContext('ETHUSDT');
      expect(exchange.getCachedCandles).toHaveBeenCalledWith('ETHUSDT', '5m', 160);
      expect(context.recentCandles).toEqual([closed]);
      expect(context.currentPrice).toBe(100.5);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not use model shadow entry_quality_model metadata to block marketOpen', async () => {
    const { exchange, service } = makeHarness({
      signal: validSignalWithShadowEntryQuality(),
      entryQuality: entryQualityConfig({ enabled: false, mode: 'OFF' }),
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
  });

  it('canonical current brain blocks DO_NOT_ENTER before legacy decision enforcement', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      signal: validSignalWithDecisionBrain('DO_NOT_ENTER'),
      decisionEnforcement: decisionEnforcementConfig(),
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_DENIED',
        reason: 'current_brain_canonical_do_not_enter',
      }),
    );
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
      }),
    );
  });

  it('canonical current brain maps WAIT_CONFIRMATION to a fail-closed non-entry', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      signal: validSignalWithDecisionBrain('WAIT_CONFIRMATION'),
      decisionEnforcement: decisionEnforcementConfig(),
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_DENIED',
        reason: 'current_brain_canonical_do_not_enter',
      }),
    );
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
      }),
    );
  });

  it('decision enforcement blocks EntryQuality BLOCK_SHADOW when EventRisk is NORMAL', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      signal: validSignalWithDecisionBrain('ENTER_NOW', 'BLOCK_SHADOW'),
      decisionEnforcement: decisionEnforcementConfig(),
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
        reason: 'entry_quality_shadow_block_hard_denied',
        metadata: expect.objectContaining({
          entryQualityRecommendation: 'BLOCK_SHADOW',
          eventRiskMode: 'NORMAL',
        }),
      }),
    );
  });

  it('decision enforcement blocks EntryQuality BLOCK_SHADOW when EventRisk is CAUTION', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      signal: validSignalWithDecisionBrain('ENTER_NOW', 'BLOCK_SHADOW'),
      eventRisk: {
        enabled: true,
        mode: 'CAUTION',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: false,
        },
        risk_off: {
          min_quality_score: 0.75,
          max_tail_risk_score: 0.35,
          allow_only_a_plus: true,
        },
        manual_only: {
          block_new_entries: false,
        },
      },
      decisionEnforcement: decisionEnforcementConfig(),
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
        reason: 'entry_quality_shadow_block_hard_denied',
        metadata: expect.objectContaining({
          entryQualityRecommendation: 'BLOCK_SHADOW',
          eventRiskMode: 'CAUTION',
        }),
      }),
    );
  });

  it('decision enforcement blocks CAUTION weak setup before setLeverage and marketOpen', async () => {
    const signal = validSignalWithDecisionBrain('ENTER_NOW', 'ALLOW_SHADOW');
    (signal.metadata!.aegis!.entry_quality_model as any).tail_risk_score = 0.62;
    const { exchange, historyLogger, service } = makeHarness({
      signal,
      eventRisk: {
        enabled: true,
        mode: 'CAUTION',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: false,
        },
        risk_off: {
          min_quality_score: 0.75,
          max_tail_risk_score: 0.35,
          allow_only_a_plus: true,
        },
        manual_only: {
          block_new_entries: false,
        },
      },
      decisionEnforcement: decisionEnforcementConfig(),
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
        reason: 'event_risk_caution_denied_weak_setup',
        metadata: expect.objectContaining({
          eventRiskMode: 'CAUTION',
          eventRiskReason: 'caution_tail_too_high',
          eventRiskWouldBlock: true,
          aPlus: false,
          setupGrade: 'WEAK',
          decisionBrainDecision: 'ENTER_NOW',
          entryQualityRecommendation: 'ALLOW_SHADOW',
        }),
      }),
    );
  });

  it('decision enforcement allows CAUTION wouldBlock A+ candidate when no other rule blocks', async () => {
    const signal = validSignalWithDecisionBrain('ENTER_NOW', 'ALLOW_SHADOW');
    (signal.metadata!.aegis!.turbo!.raw as any).turbo_score = 0.95;
    (signal.metadata!.aegis!.entry_quality_model as any).entry_quality_score = 0.6;
    (signal.metadata!.aegis!.entry_quality_model as any).tail_risk_score = 0.2;
    const { exchange, historyLogger, service } = makeHarness({
      signal,
      eventRisk: {
        enabled: true,
        mode: 'CAUTION',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: false,
        },
        risk_off: {
          min_quality_score: 0.75,
          max_tail_risk_score: 0.35,
          allow_only_a_plus: true,
        },
        manual_only: {
          block_new_entries: false,
        },
      },
      decisionEnforcement: decisionEnforcementConfig(),
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_ALLOWED',
        metadata: expect.objectContaining({
          decisionEnforcementReason: 'event_risk_caution_allowed_strong_setup',
          setupGrade: 'A_PLUS',
          eventRiskMode: 'CAUTION',
          eventRiskWouldBlock: true,
        }),
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'EVENT_RISK_SHADOW_CAUTION',
        reason: 'caution_quality_too_low',
        metadata: expect.objectContaining({
          wouldBlock: true,
          allowed: true,
        }),
      }),
    );
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
      }),
    );
  });

  it('decision enforcement blocks RISK_OFF non-A+ setup', async () => {
    const signal = validSignalWithDecisionBrain('ENTER_NOW', 'ALLOW_SHADOW');
    (signal.metadata!.aegis!.turbo!.raw as any).turbo_score = 0.95;
    (signal.metadata!.aegis!.entry_quality_model as any).tail_risk_score = 0.8;
    const { exchange, historyLogger, service } = makeHarness({
      signal,
      eventRisk: {
        enabled: true,
        mode: 'RISK_OFF',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: false,
        },
        risk_off: {
          min_quality_score: 0.75,
          max_tail_risk_score: 0.35,
          allow_only_a_plus: true,
        },
        manual_only: {
          block_new_entries: false,
        },
      },
      decisionEnforcement: decisionEnforcementConfig(),
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
        reason: 'event_risk_risk_off_denied_non_a_plus',
      }),
    );
  });

  it('decision enforcement allows ENTER_NOW A+ in RISK_OFF', async () => {
    const signal = validSignalWithDecisionBrain('ENTER_NOW', 'ALLOW_SHADOW');
    (signal.metadata!.aegis!.turbo!.raw as any).turbo_score = 0.95;
    const { exchange, historyLogger, service } = makeHarness({
      signal,
      eventRisk: {
        enabled: true,
        mode: 'RISK_OFF',
        enforce: false,
        manual_override_enabled: true,
        caution: {
          min_quality_score: 0.65,
          max_tail_risk_score: 0.45,
          require_btc_eth_confirmation: false,
        },
        risk_off: {
          min_quality_score: 0.75,
          max_tail_risk_score: 0.35,
          allow_only_a_plus: true,
        },
        manual_only: {
          block_new_entries: false,
        },
      },
      decisionEnforcement: decisionEnforcementConfig(),
    });

    await service.tick('ETHUSDT');

    expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 15);
    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.007, expect.any(String));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_ALLOWED',
        metadata: expect.objectContaining({
          decisionEnforcementReason: 'event_risk_risk_off_allowed_a_plus',
          setupGrade: 'A_PLUS',
          eventRiskMode: 'RISK_OFF',
        }),
      }),
    );
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
      }),
    );
  });

  it('decision enforcement does not affect open position management', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      signal: validSignalWithDecisionBrain('DO_NOT_ENTER'),
      decisionEnforcement: decisionEnforcementConfig(),
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 3000,
        lastEntryQty: 0.01,
        lastEntryAt: Date.now() - 5 * 60 * 1000,
        peakRoe: 0.02,
      },
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 0.01,
        entryPrice: 3000,
        leverage: 20,
        isolatedMargin: 2,
        unrealizedPnl: 0.1,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DECISION_ENFORCEMENT_DENIED',
      }),
    );
  });

  it('records history event when portfolio risk blocks', async () => {
    const { historyLogger, service } = makeHarness({
      readActivePositionSequence: [null, null],
      portfolioRisk: {
        enabled: true,
        max_open_positions: 0,
        max_same_direction_positions: 3,
        max_margin_used_pct: 0.45,
        max_notional_to_equity: 10,
      },
    });

    await service.tick('ETHUSDT');

    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PORTFOLIO_RISK_DENIED',
        metadata: expect.objectContaining({
          symbol: 'ETHUSDT',
          side: 'LONG',
          reason: 'max_open_positions_reached',
          openPositions: 0,
          limits: expect.any(Object),
        }),
      }),
    );
  });

  it('closes if stop placement throws after market open', async () => {
    const { exchange, logger, service, state } = makeHarness({
      placeStopCloseReject: true,
      readActivePositionSequence: [
        null,
        { sideMode: 'LONG', qtyAbs: 0.01, entryPrice: 3000, leverage: 20, isolatedMargin: 2 },
        { sideMode: 'LONG', qtyAbs: 0.01, entryPrice: 3000, leverage: 20, isolatedMargin: 2 },
        null,
      ],
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith(
      'ETHUSDT',
      'LONG',
      0.01,
      'LONG',
      'AEGIS_BRACKET_FAILED',
    );
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'IDLE',
        lastExitReason: 'AEGIS_BRACKET_FAILED',
        lastBracketStatus: 'FAILED_CLOSED',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith('aegis_bracket_creation_failed', expect.any(Object));
  });

  it('closes if take-profit placement throws after stop is placed', async () => {
    const { exchange, logger, notifier, service, state } = makeHarness({
      placeTpCloseReject: true,
      readActivePositionSequence: [
        null,
        { sideMode: 'LONG', qtyAbs: 0.01, entryPrice: 3000, leverage: 20, isolatedMargin: 2 },
        { sideMode: 'LONG', qtyAbs: 0.01, entryPrice: 3000, leverage: 20, isolatedMargin: 2 },
        null,
      ],
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalled();
    expect(exchange.placeStopClose).toHaveBeenCalled();
    expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith(
      'ETHUSDT',
      'LONG',
      0.01,
      'LONG',
      'AEGIS_BRACKET_FAILED',
    );
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'IDLE',
        lastExitReason: 'AEGIS_BRACKET_FAILED',
        lastBracketStatus: 'FAILED_CLOSED',
      }),
    );
    expect(state.set).not.toHaveBeenCalledWith(
      expect.objectContaining({
        currentRegime: 'AEGIS_TURBO',
        lastBracketStatus: 'OK',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith('aegis_bracket_creation_failed', expect.any(Object));
    expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('BRACKET FAILED'));
    expect(logger.info).not.toHaveBeenCalledWith(
      'telegram_block_notification_suppressed',
      expect.any(Object),
    );
  });

  it('recreates missing Aegis brackets from state values while managing an open position', async () => {
    const { exchange, service } = makeHarness({ closeOrders: [] });
    let currentState: any = {
      mode: 'LONG_RIDE',
      positionOwner: 'AEGIS',
      tradeOrigin: 'BOT',
      ownershipStatus: 'VERIFIED',
      eligibleForBotMetrics: true,
      currentRegime: 'AEGIS_TURBO',
      lastStrategy: 'AEGIS_TURBO',
      lastSide: 'LONG',
      lastEntryPrice: 3000,
      lastLeverage: 20,
      lastStopRoe: -0.15,
      lastTakeProfitRoe: 0.25,
      lastTrailingActivationRoe: 0.15,
      lastTrailingCallbackRoe: 0.08,
      lastEntryAt: Date.now(),
      lastEntryQty: 0.01,
      lastPeakPrice: 3000,
    };
    (service as any).deps.state.get.mockImplementation(() => currentState);
    (service as any).deps.state.set.mockImplementation((patch: any) => {
      currentState = { ...currentState, ...patch };
      return currentState;
    });

    await service.tick('ETHUSDT');

    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 2977.5);
    expect(exchange.placeTpClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 3037.5);
  });

  it('taints and excludes a bot trade after an external size increase and replaces brackets', async () => {
    const oldOrders = [
      { orderId: 'old-sl', type: 'STOP_MARKET', stopPrice: 98, closePosition: true },
      { orderId: 'old-tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 102, closePosition: true },
    ];
    const { exchange, historyLogger, logger, service, state } = makeHarness({
      markPrice: 100,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 2,
        entryPrice: 95,
        leverage: 20,
        isolatedMargin: 9.5,
      },
      closeOrdersSequence: [oldOrders, [], []],
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'manual-add-long',
        lastPeakPrice: 105,
        peakRoe: 0.5,
        lowestRoe: -0.2,
        lastStopRoe: -0.15,
        lastTakeProfitRoe: 0.25,
        lastTrailStop: 101,
        breakEvenExecuted: true,
        lastBreakEvenStop: 100.3,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.cancelOrderById).toHaveBeenCalledWith('ETHUSDT', 'old-sl');
    expect(exchange.cancelOrderById).toHaveBeenCalledWith('ETHUSDT', 'old-tp');
    expect(exchange.placeStopClose).toHaveBeenCalled();
    expect(exchange.placeTpClose).toHaveBeenCalled();
    expect(state.get()).toEqual(
      expect.objectContaining({
        ownershipStatus: 'TAINTED',
        eligibleForBotMetrics: false,
        metricsExclusionReason: 'EXTERNAL_QUANTITY_INCREASE',
      }),
    );
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'MANUAL_POSITION_SIZE_INCREASE_RECONCILED',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_managed_position_tainted',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        previousQty: 1,
        currentQty: 2,
        action: 'CONTINUE_MANAGEMENT_TAINTED',
      }),
    );
  });

  it('preserves manually edited SL/TP when position quantity did not increase', async () => {
    const manualOrders = [
      { orderId: 'manual-sl', type: 'STOP_MARKET', stopPrice: 99.1 },
      { orderId: 'manual-tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 108 },
    ];
    const { exchange, service } = makeHarness({
      markPrice: 100,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      closeOrders: manualOrders,
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'manual-stop-only',
        lastPeakPrice: 100,
        peakRoe: 0,
        lowestRoe: 0,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(exchange.cancelOrderById).not.toHaveBeenCalled();
  });

  it('uses live 40x leverage to activate trailing for an adopted manual position', async () => {
    const manualOrders = [
      { orderId: 'manual-sl', type: 'STOP_MARKET', stopPrice: 0.7455 },
      { orderId: 'manual-tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 0.7681 },
    ];
    const { exchange, service, state } = makeHarness({
      preserveUnverifiedState: true,
      markPrice: 0.763,
      closeOrders: manualOrders,
      symbolFilters: {
        qtyPrecision: 0,
        pricePrecision: 4,
        minNotional: 5,
        tickSize: 0.0001,
        stepSize: 1,
      },
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 100,
        entryPrice: 0.753,
        leverage: 40,
        isolatedMargin: 1.8825,
      },
      initialState: {
        mode: 'LONG_RIDE',
        positionOwner: 'EXTERNAL',
        tradeOrigin: 'MANUAL_EXTERNAL',
        ownershipStatus: 'UNKNOWN',
        eligibleForBotMetrics: false,
        metricsExclusionReason: 'MANUAL_POSITION',
        lastSide: 'LONG',
        lastEntryPrice: 0.753,
        lastLeverage: 20,
        lastActualLeverage: 20,
        lastEntryQty: 100,
        lastEntryAt: Date.now(),
        lastPeakPrice: 0.753,
        peakRoe: 0,
        lowestRoe: 0,
        lastTrailingActivationRoe: 0.4,
        lastTrailingCallbackRoe: 0.08,
      },
    });

    await service.tick('ETHUSDT');

    expect(state.get()).toEqual(
      expect.objectContaining({
        lastLeverage: 40,
        lastActualLeverage: 40,
        lastTrailStop: 0.7622,
      }),
    );
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.7622);
    expect(exchange.cancelOrderById.mock.invocationCallOrder[0]).toBeLessThan(
      exchange.placeStopClose.mock.invocationCallOrder[0],
    );
    expect(exchange.cancelStopOrdersForSide).not.toHaveBeenCalled();
    expect(exchange.cancelOrderById).toHaveBeenCalledWith('ETHUSDT', 'manual-sl');
    expect(exchange.cancelOrderById).not.toHaveBeenCalledWith('ETHUSDT', 'manual-tp');
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
  });

  it('does not migrate or replace external quantity brackets when size is unchanged', async () => {
    const quantityOrders = [
      {
        orderId: 'qty-sl',
        type: 'STOP_MARKET',
        stopPrice: 94.29,
        closePosition: false,
        reduceOnly: true,
        quantity: 2,
      },
      {
        orderId: 'qty-tp',
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: 96.19,
        closePosition: false,
        reduceOnly: true,
        quantity: 2,
      },
    ];
    const stopVerified = [
      { orderId: 'close-sl', type: 'STOP_MARKET', stopPrice: 94.29, closePosition: true },
      quantityOrders[1],
    ];
    const fullyVerified = [
      stopVerified[0],
      { orderId: 'close-tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 96.19, closePosition: true },
    ];
    const { exchange, historyLogger, service, state } = makeHarness({
      markPrice: 95,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 2,
        entryPrice: 95,
        leverage: 20,
        isolatedMargin: 9.5,
      },
      closeOrdersSequence: [quantityOrders, stopVerified, fullyVerified],
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 95,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 2,
        lastEntryMargin: 9.5,
        lastTradeId: 'manual-add-migrate',
        lastPeakPrice: 95,
        lastStopRoe: -0.15,
        lastTakeProfitRoe: 0.25,
        lastManualSizeIncreaseAt: Date.now() - 60_000,
        lastManualSizeIncreaseQty: 1,
        lastManualSizeIncreasePreviousQty: 1,
        lastManualSizeIncreaseBracketMode: 'REDUCE_ONLY_QTY',
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(state.get()).toEqual(
      expect.objectContaining({
        lastEntryQty: 2,
        lastManualSizeIncreaseBracketMode: 'REDUCE_ONLY_QTY',
        ownershipStatus: 'VERIFIED',
        eligibleForBotMetrics: true,
      }),
    );
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'MANUAL_POSITION_SIZE_INCREASE_RECONCILED',
      }),
    );
  });

  it('taints a manual position reduction and replaces brackets', async () => {
    const manualOrders = [
      { orderId: 'manual-sl', type: 'STOP_MARKET', stopPrice: 99.1 },
      { orderId: 'manual-tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 108 },
    ];
    const { exchange, service, state } = makeHarness({
      markPrice: 100,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 0.5,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 2.5,
      },
      closeOrdersSequence: [manualOrders, [], []],
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'manual-reduction',
        lastPeakPrice: 100,
        peakRoe: 0,
        lowestRoe: 0,
      },
    });

    await service.tick('ETHUSDT');

    expect(state.get()).toEqual(
      expect.objectContaining({
        ownershipStatus: 'TAINTED',
        eligibleForBotMetrics: false,
        metricsExclusionReason: 'EXTERNAL_QUANTITY_REDUCTION',
      }),
    );
    expect(exchange.cancelOrderById).toHaveBeenCalled();
    expect(exchange.placeStopClose).toHaveBeenCalled();
    expect(exchange.placeTpClose).toHaveBeenCalled();
  });

  it('replaces brackets after an external quantity change and marks position TAINTED', async () => {
    const oldOrders = [
      { orderId: 'old-sl', type: 'STOP_MARKET', stopPrice: 98, closePosition: true },
      { orderId: 'old-tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 102, closePosition: true },
    ];
    const { exchange, logger, notifier, service, state } = makeHarness({
      markPrice: 95,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 2,
        entryPrice: 95,
        leverage: 20,
        isolatedMargin: 9.5,
      },
      closeOrdersSequence: [oldOrders, [], []],
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'manual-add-unverified',
        lastPeakPrice: 100,
        peakRoe: 0,
        lowestRoe: 0,
        lastStopRoe: -0.15,
        lastTakeProfitRoe: 0.25,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.cancelOrderById).toHaveBeenCalledWith('ETHUSDT', 'old-sl');
    expect(exchange.cancelOrderById).toHaveBeenCalledWith('ETHUSDT', 'old-tp');
    expect(exchange.placeStopClose).toHaveBeenCalled();
    expect(exchange.placeTpClose).toHaveBeenCalled();
    expect(state.get()).toEqual(
      expect.objectContaining({
        ownershipStatus: 'TAINTED',
        eligibleForBotMetrics: false,
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_managed_position_tainted',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        previousQty: 1,
        currentQty: 2,
      }),
    );
    expect(notifier.sendAlert).not.toHaveBeenCalled();
  });

  it('executes MOVE_SL_BE for a LONG position', async () => {
    const { exchange, historyLogger, service, state } = makeHarness({
      markPrice: 100.45,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      closeOrders: [
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 98 },
        { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 105 },
      ],
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'be-long',
        lastPeakPrice: 100,
        peakRoe: 0,
        lowestRoe: 0,
        lastStopPrice: 98,
        lastBreakEvenRoe: 0.08,
        lastTrailingActivationRoe: 0.15,
        lastTrailingCallbackRoe: 0.08,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.cancelStopOrdersForSide).not.toHaveBeenCalled();
    expect(exchange.cancelOrderById).toHaveBeenCalledWith('ETHUSDT', 'sl');
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 100.3, 1);
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BREAK_EVEN_EXECUTED',
        reason: 'MOVE_SL_BE',
        new_stop: 100.3,
      }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'SL_MOVED',
        reason: 'MOVE_SL_BE',
        new_stop: 100.3,
      }),
    );
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        breakEvenExecuted: true,
        lastBreakEvenStop: 100.3,
        lastStopPrice: 100.3,
      }),
    );
  });

  it('executes MOVE_SL_BE for a SHORT position', async () => {
    const { exchange, historyLogger, service, state } = makeHarness({
      markPrice: 99.55,
      readActivePosition: {
        sideMode: 'SHORT',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      closeOrders: [
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 102 },
        { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 95 },
      ],
      initialState: {
        mode: 'SHORT_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'SHORT',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'be-short',
        lastPeakPrice: 100,
        peakRoe: 0,
        lowestRoe: 0,
        lastStopPrice: 102,
        lastBreakEvenRoe: 0.08,
        lastTrailingActivationRoe: 0.15,
        lastTrailingCallbackRoe: 0.08,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.cancelStopOrdersForSide).not.toHaveBeenCalled();
    expect(exchange.cancelOrderById).toHaveBeenCalledWith('ETHUSDT', 'sl');
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'SHORT', 99.7, 1);
    expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BREAK_EVEN_EXECUTED',
        reason: 'MOVE_SL_BE',
        new_stop: 99.7,
      }),
    );
    expect(state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        breakEvenExecuted: true,
        lastBreakEvenStop: 99.7,
        lastStopPrice: 99.7,
      }),
    );
  });

  it('does not execute break-even twice', async () => {
    const { exchange, service } = makeHarness({
      markPrice: 100.45,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'be-dup',
        lastPeakPrice: 100,
        peakRoe: 0.09,
        lowestRoe: 0,
        breakEvenExecuted: true,
        lastBreakEvenStop: 100.3,
        lastTrailStop: 100.3,
        lastStopPrice: 100.3,
        lastBreakEvenRoe: 0.08,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
  });

  it('skips MOVE_SL_BE when the stop would immediately trigger for a LONG', async () => {
    const { exchange, logger, service, state } = makeHarness({
      markPrice: 99.5,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      closeOrders: [
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 98 },
        { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 105 },
      ],
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'be-immediate',
        lastPeakPrice: 100.45,
        peakRoe: 0.09,
        lowestRoe: 0,
        lastStopPrice: 98,
        lastBreakEvenRoe: 0.08,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.cancelStopOrdersForSide).not.toHaveBeenCalled();
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ breakEvenExecuted: true }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_safe_stop_move_skipped',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        side: 'LONG',
        markPrice: 99.5,
        newStopPrice: 100.3,
        skipReason: 'immediate_trigger_risk',
      }),
    );
  });

  it('uses be_roe from YAML/config before the fallback threshold', async () => {
    const { exchange, configManager, service } = makeHarness({
      markPrice: 100.45,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      closeOrders: [
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 98 },
        { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 105 },
      ],
      regime: regimeConfig({ beRoe: 0.08 }),
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'be-yaml',
        lastPeakPrice: 100,
        peakRoe: 0,
        lowestRoe: 0,
        lastStopPrice: 98,
      },
    });

    await service.tick('ETHUSDT');

    expect(configManager.getGuardianConfig).toHaveBeenCalledWith('AEGIS_TURBO', 'ETHUSDT');
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 100.3, 1);
  });

  it('falls back to 0.10 BE threshold when config omits be_roe', async () => {
    const { exchange, service } = makeHarness({
      markPrice: 100.45,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      regime: regimeConfig({ beRoe: undefined }),
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'be-fallback',
        lastPeakPrice: 100,
        peakRoe: 0,
        lowestRoe: 0,
        lastStopPrice: 98,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
  });

  it('logs and alerts when MOVE_SL_BE fails without marking state as executed', async () => {
    const { exchange, logger, notifier, service, state } = makeHarness({
      markPrice: 100.45,
      placeStopCloseReject: true,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      closeOrders: [
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 98 },
        { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 105 },
      ],
      initialState: {
        mode: 'LONG_RIDE',
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: 'AEGIS_TURBO',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastLeverage: 20,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'be-fail',
        lastPeakPrice: 100,
        peakRoe: 0,
        lowestRoe: 0,
        lastStopPrice: 98,
        lastBreakEvenRoe: 0.08,
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'aegis_break_even_stop_move_failed',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        attemptedStopPrice: 100.3,
      }),
    );
    expect(notifier.sendAlert).toHaveBeenCalledWith(
      'AEGIS BREAK-EVEN FAILED',
      expect.stringContaining('ETHUSDT LONG'),
    );
    expect(state.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ breakEvenExecuted: true }),
    );
  });

  it('keeps break-even state scoped to the active symbol', async () => {
    const { exchange, service, symbolStores } = makeHarness({
      symbols: ['ADAUSDT', 'ETHUSDT'],
      symbolModes: { ADAUSDT: 'LIVE', ETHUSDT: 'LIVE' },
      markPrice: 100.45,
      readActivePosition: {
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 5,
      },
      closeOrders: [
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 98 },
        { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 105 },
      ],
      symbolStates: {
        ADAUSDT: {
          mode: 'LONG_RIDE',
          currentRegime: 'AEGIS_TURBO',
          lastStrategy: 'AEGIS_TURBO',
          lastSide: 'LONG',
          lastEntryPrice: 100,
          lastLeverage: 20,
          lastEntryAt: Date.now() - 10 * 60 * 1000,
          lastEntryQty: 1,
          lastEntryMargin: 5,
          lastTradeId: 'be-ada',
          lastPeakPrice: 100,
          peakRoe: 0,
          lowestRoe: 0,
          lastStopPrice: 98,
          lastBreakEvenRoe: 0.08,
        },
        ETHUSDT: {
          mode: 'LONG_RIDE',
          currentRegime: 'AEGIS_TURBO',
          lastStrategy: 'AEGIS_TURBO',
          lastSide: 'LONG',
          lastEntryPrice: 200,
          lastLeverage: 20,
          lastEntryAt: Date.now() - 10 * 60 * 1000,
          lastEntryQty: 1,
          lastEntryMargin: 10,
          lastTradeId: 'eth-open',
          lastPeakPrice: 200,
          peakRoe: 0,
          lowestRoe: 0,
          lastStopPrice: 196,
          lastBreakEvenRoe: 0.08,
        },
      },
    });

    await service.tick('ADAUSDT');

    expect(exchange.placeStopClose).toHaveBeenCalledWith('ADAUSDT', 'LONG', 100.3, 1);
    expect(symbolStores.get('ADAUSDT')?.get()).toEqual(
      expect.objectContaining({ breakEvenExecuted: true, lastBreakEvenStop: 100.3 }),
    );
    expect(symbolStores.get('ETHUSDT')?.get()).not.toEqual(
      expect.objectContaining({ breakEvenExecuted: true }),
    );
  });
  it('counts only confirmed Phase O SHORT opens for the Phase O daily limit', async () => {
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['BTCUSDT'],
      symbolModes: { BTCUSDT: 'LIVE' },
      signal: phaseOShortSignal('BTCUSDT'),
      yaml: yamlTurbo({ allow_short: true }),
      phaseOShortLive: { enabled: true, max_phase_o_trades_per_day: 1 },
    });

    await service.tick('BTCUSDT');
    expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
    expect((service as any).phaseOShortTradesToday).toBe(1);
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'POSITION_CONFIRMED' }),
    );
  });

  it('blocks Phase O SHORT only after the configured real opened-trade limit', async () => {
    const { exchange, historyLogger, logger, service } = makeHarness({
      symbols: ['BTCUSDT'],
      symbolModes: { BTCUSDT: 'LIVE' },
      signal: phaseOShortSignal('BTCUSDT'),
      yaml: yamlTurbo({ allow_short: true }),
      phaseOShortLive: { enabled: true, max_phase_o_trades_per_day: 1 },
    });
    (service as any).phaseOShortTradesToday = 1;

    await service.tick('BTCUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_DENIED',
        reason: 'risk_guard_max_phase_o_trades_per_day',
        metadata: expect.objectContaining({
          countSource: 'trade_opened',
          currentCount: 1,
          limit: 1,
          phaseOOnly: true,
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'risk_guard_max_phase_o_trades_per_day',
      expect.objectContaining({ countSource: 'trade_opened' }),
    );
  });

  it('does not apply the Phase O SHORT daily counter to legacy LONG', async () => {
    const { exchange, service } = makeHarness({
      signal: validSignal(),
      phaseOShortLive: { enabled: true, max_phase_o_trades_per_day: 1 },
    });
    (service as any).phaseOShortTradesToday = 1;

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith(
      'ETHUSDT',
      'LONG',
      expect.any(Number),
      expect.any(String),
    );
  });

  it('sizes the initial order from 90 percent of available balance', async () => {
    const { exchange, service } = makeHarness({
      balance: 10,
      accountSnapshot: {
        walletBalance: 10,
        availableBalance: 0.8,
        equityTotal: 10,
      },
      markPrice: 100,
      positionFractionOverride: {
        symbol: 'ETHUSDT',
        side: 'LONG',
        positionFraction: 0.9,
        ruleIndex: 0,
        ruleName: 'all_symbols_available_wallet_90pct',
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.102, expect.any(String));
  });

  it('caps the initial order at the maximum notional for the leverage tier', async () => {
    const { exchange, service } = makeHarness({
      balance: 20,
      markPrice: 100,
      symbolFilters: {
        qtyPrecision: 3,
        pricePrecision: 2,
        minNotional: 5,
        notionalCap: 10,
        tickSize: 0.01,
        stepSize: 0.001,
      },
      positionFractionOverride: {
        symbol: 'ETHUSDT',
        side: 'LONG',
        positionFraction: 0.9,
        ruleIndex: 0,
        ruleName: 'all_symbols_available_wallet_90pct',
      },
    });

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.1, expect.any(String));
  });

  it('reduces rejected entry quantity repeatedly until Binance accepts it', async () => {
    const sizeError = () => Object.assign(new Error('Margin is insufficient.'), { code: -2019 });
    const { exchange, historyLogger, logger, service } = makeHarness({
      positionFractionOverride: {
        symbol: 'ETHUSDT',
        side: 'LONG',
        positionFraction: 0.9,
        ruleIndex: 0,
        ruleName: 'all_symbols_available_wallet_90pct',
      },
    });
    exchange.marketOpen
      .mockRejectedValueOnce(sizeError())
      .mockRejectedValueOnce(sizeError())
      .mockResolvedValueOnce({ avgPrice: 3000, orderId: 'adjusted-entry' });

    await service.tick('ETHUSDT');

    const clientOrderIds = exchange.marketOpen.mock.calls.map((call: any[]) => call[3]);
    expect(clientOrderIds).toEqual([expect.any(String), expect.any(String), expect.any(String)]);
    expect(new Set(clientOrderIds)).toHaveLength(3);
    expect(exchange.marketOpen).toHaveBeenNthCalledWith(
      1,
      'ETHUSDT',
      'LONG',
      0.085,
      clientOrderIds[0],
    );
    expect(exchange.marketOpen).toHaveBeenNthCalledWith(
      2,
      'ETHUSDT',
      'LONG',
      0.076,
      clientOrderIds[1],
    );
    expect(exchange.marketOpen).toHaveBeenNthCalledWith(
      3,
      'ETHUSDT',
      'LONG',
      0.068,
      clientOrderIds[2],
    );
    expect(logger.warn).toHaveBeenCalledWith('shared_execution_quantity_retry', expect.any(Object));
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ORDER_QUANTITY_ADJUSTED',
      }),
    );
  });

  it('stops after bounded size retries and reports the final error', async () => {
    const sizeError = Object.assign(new Error('Margin is insufficient.'), { code: -2019 });
    const { exchange, historyLogger, notifier, service } = makeHarness({
      positionFractionOverride: {
        symbol: 'ETHUSDT',
        side: 'LONG',
        positionFraction: 0.9,
        ruleIndex: 0,
        ruleName: 'all_symbols_available_wallet_90pct',
      },
    });
    exchange.marketOpen.mockRejectedValue(sizeError);

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledTimes(6);
    expect(exchange.readActivePosition).toHaveBeenCalledTimes(1);
    const clientOrderIds = exchange.marketOpen.mock.calls.map((call: any[]) => call[3]);
    expect(new Set(clientOrderIds)).toHaveLength(6);
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ORDER_SIZE_REJECTED',
        reason: 'AEGIS_ENTRY_QUANTITY_ADJUSTMENT_EXHAUSTED',
      }),
    );
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('AEGIS ENTRY SIZE REJECTED'),
    );
  });

  it('does not retry ambiguous market-open failures and reports them', async () => {
    const { exchange, notifier, service } = makeHarness();
    exchange.marketOpen.mockRejectedValue(new Error('request timed out'));

    await service.tick('ETHUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('AEGIS ENTRY FAILED'),
    );
  });

  it('detects Phase O SHORT metadata under metadata.aegis.turbo', () => {
    const { service } = makeHarness({ signal: phaseOShortSignalAtPath('metadata.aegis.turbo') });
    const metadata = (service as any).extractPhaseOTurboMetadata(
      phaseOShortSignalAtPath('metadata.aegis.turbo'),
      'SHORT',
    );
    expect(metadata).toMatchObject({
      isPhaseO: true,
      side: 'SHORT',
      entryEnabled: true,
      avoidOnly: false,
      sourcePath: 'signal.metadata.aegis.turbo.phase_o',
    });
    expect(
      (service as any).isPhaseOShortLiveSignal(
        phaseOShortSignalAtPath('metadata.aegis.turbo'),
        'SHORT',
      ),
    ).toBe(true);
  });

  it('detects Phase O SHORT metadata under aegis.turbo fallback', () => {
    const { service } = makeHarness({ signal: phaseOShortSignalAtPath('aegis.turbo') });
    expect(
      (service as any).extractPhaseOTurboMetadata(phaseOShortSignalAtPath('aegis.turbo'), 'SHORT'),
    ).toMatchObject({
      isPhaseO: true,
      side: 'SHORT',
      sourcePath: 'signal.aegis.turbo.phase_o',
    });
    expect(
      (service as any).isPhaseOShortLiveSignal(phaseOShortSignalAtPath('aegis.turbo'), 'SHORT'),
    ).toBe(true);
  });

  it('detects Phase O SHORT metadata under metadata.turbo fallback', () => {
    const { service } = makeHarness({ signal: phaseOShortSignalAtPath('metadata.turbo') });
    expect(
      (service as any).extractPhaseOTurboMetadata(
        phaseOShortSignalAtPath('metadata.turbo'),
        'SHORT',
      ),
    ).toMatchObject({
      isPhaseO: true,
      side: 'SHORT',
      sourcePath: 'signal.metadata.turbo.phase_o',
    });
    expect(
      (service as any).isPhaseOShortLiveSignal(phaseOShortSignalAtPath('metadata.turbo'), 'SHORT'),
    ).toBe(true);
  });

  it('does not classify LONG as Phase O SHORT even with Phase O metadata', () => {
    const { service } = makeHarness();
    const signal = validSignal() as any;
    signal.metadata.aegis.turbo.phase_o = {
      phase_o_live_enabled: true,
      phase_o_live_mode: 'experimental_short_only',
      phase_o_link_avoid_only: false,
      phase_o_link_entry_enabled: false,
    };
    expect((service as any).isPhaseOShortLiveSignal(signal, 'LONG')).toBe(false);
  });

  it('never classifies LINK avoid-only as Phase O SHORT entry', () => {
    const { logger, service } = makeHarness({ signal: phaseOLinkAvoidOnlySignal() });
    expect((service as any).isPhaseOShortLiveSignal(phaseOLinkAvoidOnlySignal(), 'SHORT')).toBe(
      false,
    );
    expect(logger.info).toHaveBeenCalledWith(
      'phase_o_link_avoid_only_no_entry',
      expect.objectContaining({ symbol: 'LINKUSDT', link_avoid_only: true }),
    );
  });

  it('applies Phase O SHORT guard modes before legacy ShortGate enforcement', async () => {
    const { exchange, historyLogger, logger, service } = makeHarness({
      symbols: ['BTCUSDT'],
      symbolModes: { BTCUSDT: 'LIVE' },
      signal: phaseOShortSignalAtPath('metadata.aegis.turbo', 'BTCUSDT'),
      yaml: yamlTurbo({ allow_short: true }),
      shortGate: {
        enabled: true,
        position_fraction_multiplier: 1.0,
        max_leverage: 10,
        block_symbols: [],
      },
      phaseOShortLive: { enabled: true, allow_orders: true, max_phase_o_trades_per_day: 20 },
    });

    await service.tick('BTCUSDT');

    expect(exchange.marketOpen).toHaveBeenCalledWith(
      'BTCUSDT',
      'SHORT',
      expect.any(Number),
      expect.any(String),
    );
    expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'SHORT_GATE_DENIED' }),
    );
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PHASE_O_SHORT_GUARD_MODES_APPLIED',
        reason: 'phase_o_short_guard_modes_applied',
        metadata: expect.objectContaining({
          phase_o_short_detected: true,
          phase_o_short_guard_modes_applied: true,
          phase_o_metadata_source_path: 'signal.metadata.aegis.turbo.phase_o',
          guard_modes: expect.objectContaining({ clean_entry: 'SHADOW' }),
        }),
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'phase_o_short_guard_modes_applied',
      expect.objectContaining({
        phase_o_short_detected: true,
        phase_o_short_guard_modes_applied: true,
        phase_o_metadata_source_path: 'signal.metadata.aegis.turbo.phase_o',
        guard_modes: expect.objectContaining({ clean_entry: 'SHADOW' }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'aegis_phase_o_technical_entry_protection_not_enforced',
      expect.objectContaining({
        symbol: 'BTCUSDT',
        side: 'SHORT',
        regime_guard_mode: 'SHADOW',
        action: 'OBSERVATION_ONLY',
      }),
    );
  });

  it('fails closed for a legacy SHORT without the canonical current-brain contract', async () => {
    const signal = shortSignal('BTCUSDT', 0.79, 3) as any;
    delete signal.metadata.aegis.candidate;
    delete signal.metadata.aegis.candidate_status;
    delete signal.metadata.aegis.live_enabled;
    delete signal.metadata.aegis.prod;
    delete signal.metadata.aegis.decision_brain;
    const { exchange, historyLogger, service } = makeHarness({
      symbols: ['BTCUSDT'],
      symbolModes: { BTCUSDT: 'LIVE' },
      signal,
      yaml: yamlTurbo({ allow_short: true }),
      shortGate: {
        enabled: true,
        position_fraction_multiplier: 1.0,
        max_leverage: 10,
        block_symbols: [],
      },
    });

    await service.tick('BTCUSDT');

    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'GATE_DENIED',
        reason: 'current_brain_canonical_contract_required',
      }),
    );
  });
});
