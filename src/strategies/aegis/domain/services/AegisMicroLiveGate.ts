import { AegisBlock } from '../AegisStrategy';
import { inspectCurrentBrainCanonicalDecision } from '../CurrentBrainCanonicalDecision';
import { evaluateSharedEntrySafety } from '../../../../core/risk/SharedEntrySafetyGate';

export type LiquidityStressStatus = 'NO_DATA' | 'FRESH' | 'STALE';
export const LIQUIDITY_STRESS_INPUT_VERSION = 'DEPTH20_PARTIAL_V1' as const;

export interface AegisMicroLiveGateConfig {
  tradingMode: string;
  liveEnabled: boolean;
  yamlEnabled?: boolean;
  yamlLiveEnabled?: boolean;
  allowShort: boolean;
  minScore: number;
  leverageCap: number;
  positionFractionCap: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  dailyLossStopPct: number;
  minCooldownMs: number;
  maxLiquidityStress: number;
  stopRoe: number;
  takeProfitRoe: number;
  trailingActivationRoe: number;
  trailingCallbackRoe: number;
  requireBrackets?: boolean;
  closeIfBracketFails?: boolean;
}

export interface AegisMicroLiveGateContext {
  symbol: string;
  signal: {
    aegis?: AegisBlock;
  };
  hasOpenPosition: boolean;
  tradesToday: number;
  consecutiveLosses: number;
  timeSinceLastExitMs: number;
  liquidityStress: number;
  liquidityStressStatus: LiquidityStressStatus;
  liquidityStressAgeMs?: number;
  liquidityStressInputVersion: typeof LIQUIDITY_STRESS_INPUT_VERSION;
  dailyPnlPct?: number;
}

export interface AegisMicroLiveGateDecision {
  allowed: boolean;
  side?: 'LONG' | 'SHORT';
  reason: string;
  leverage: number;
  positionFraction: number;
  stopRoe: number;
  takeProfitRoe: number;
  trailingActivationRoe: number;
  trailingCallbackRoe: number;
  turboScore?: number;
  votes?: {
    long?: number;
    short?: number;
    neutral?: number;
  };
  rawReason?: string;
  gatedReason?: string;
  gatedBlockedBy?: string | null;
  liquidityStressStatus?: LiquidityStressStatus;
  liquidityStressAgeMs?: number;
  liquidityStressInputVersion?: typeof LIQUIDITY_STRESS_INPUT_VERSION;
}

const DEFAULT_LEVERAGE = 15;
const DEFAULT_POSITION_FRACTION = 0.08;
const DEFAULT_MIN_SCORE = 0.5;
const DEFAULT_MAX_TRADES_PER_DAY = 2;
const DEFAULT_MAX_CONSECUTIVE_LOSSES = 2;
const DEFAULT_DAILY_LOSS_STOP_PCT = 0.1;
const DEFAULT_MIN_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_MAX_LIQUIDITY_STRESS = 0.7;
const DEFAULT_STOP_ROE = -0.15;
const DEFAULT_TAKE_PROFIT_ROE = 0.25;
const DEFAULT_TRAILING_ACTIVATION_ROE = 0.15;
const DEFAULT_TRAILING_CALLBACK_ROE = 0.08;
const DEFAULT_POSITION_FRACTION_CAP = 0.1;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeNegative(value: unknown, fallback: number): number {
  if (!finiteNumber(value) || value === 0) return fallback;
  return -Math.abs(value);
}

function normalizePositive(value: unknown, fallback: number): number {
  if (!finiteNumber(value) || value === 0) return fallback;
  return Math.abs(value);
}

function buildDecision(
  ctx: AegisMicroLiveGateContext,
  config: AegisMicroLiveGateConfig,
  reason: string,
  allowed = false,
  side?: 'LONG' | 'SHORT',
  leverage = 0,
  positionFraction = 0,
): AegisMicroLiveGateDecision {
  const turbo = ctx.signal.aegis?.turbo;
  const raw = turbo?.raw;
  const gated = turbo?.gated;

  return {
    allowed,
    side,
    reason,
    leverage,
    positionFraction,
    stopRoe: normalizeNegative(config.stopRoe, DEFAULT_STOP_ROE),
    takeProfitRoe: normalizePositive(config.takeProfitRoe, DEFAULT_TAKE_PROFIT_ROE),
    trailingActivationRoe: normalizePositive(
      config.trailingActivationRoe,
      DEFAULT_TRAILING_ACTIVATION_ROE,
    ),
    trailingCallbackRoe: normalizePositive(
      config.trailingCallbackRoe,
      DEFAULT_TRAILING_CALLBACK_ROE,
    ),
    turboScore: raw?.turbo_score,
    votes: raw?.votes,
    rawReason: raw?.reason,
    gatedReason: gated?.reason,
    gatedBlockedBy: gated?.blocked_by,
    liquidityStressStatus: ctx.liquidityStressStatus,
    liquidityStressAgeMs: ctx.liquidityStressAgeMs,
    liquidityStressInputVersion: ctx.liquidityStressInputVersion,
  };
}

function evaluateOperationalSafety(
  ctx: AegisMicroLiveGateContext,
  config: AegisMicroLiveGateConfig,
) {
  if (ctx.liquidityStressStatus !== 'FRESH') {
    return {
      allowed: false as const,
      reason:
        ctx.liquidityStressStatus === 'NO_DATA'
          ? ('liquidity_data_no_data' as const)
          : ('liquidity_data_stale' as const),
    };
  }
  return evaluateSharedEntrySafety({
    hasOpenPosition: ctx.hasOpenPosition,
    tradesToday: ctx.tradesToday,
    maxTradesPerDay: config.maxTradesPerDay,
    consecutiveLosses: ctx.consecutiveLosses,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
    timeSinceLastExitMs: ctx.timeSinceLastExitMs,
    minCooldownMs: config.minCooldownMs,
    liquidityStress: ctx.liquidityStress,
    maxLiquidityStress: config.maxLiquidityStress,
    dailyPnlPct: ctx.dailyPnlPct,
    dailyLossStopPct: config.dailyLossStopPct,
  });
}

export function shouldEnterAegisTurboMicroLive(
  ctx: AegisMicroLiveGateContext,
  config: AegisMicroLiveGateConfig,
): AegisMicroLiveGateDecision {
  if (config.tradingMode !== 'AEGIS_TURBO_MICRO_LIVE') {
    return buildDecision(ctx, config, 'trading_mode_not_turbo_micro_live');
  }

  if (config.liveEnabled !== true) {
    return buildDecision(ctx, config, 'aegis_live_disabled');
  }

  if (config.yamlEnabled === false) {
    return buildDecision(ctx, config, 'aegis_turbo_yaml_disabled');
  }

  if (config.yamlEnabled === true && config.yamlLiveEnabled !== true) {
    return buildDecision(ctx, config, 'aegis_turbo_yaml_live_disabled');
  }

  const canonicalDecision = inspectCurrentBrainCanonicalDecision(ctx.signal.aegis, ctx.symbol);
  if (!canonicalDecision.recognized) {
    return buildDecision(ctx, config, 'current_brain_canonical_contract_required');
  }

  if (!canonicalDecision.valid) {
    return buildDecision(ctx, config, 'current_brain_canonical_contract_invalid');
  }

  const operationalSafety = evaluateOperationalSafety(ctx, config);
  if (!operationalSafety.allowed) {
    return buildDecision(ctx, config, operationalSafety.reason);
  }

  if (canonicalDecision.selected !== true) {
    return buildDecision(ctx, config, 'current_brain_canonical_do_not_enter');
  }

  const side = canonicalDecision.side!;
  if (side === 'SHORT' && config.allowShort !== true) {
    return buildDecision(ctx, config, 'short_disabled');
  }

  const leverage = Math.min(DEFAULT_LEVERAGE, config.leverageCap);
  const positionFraction = Math.min(DEFAULT_POSITION_FRACTION, config.positionFractionCap);

  return buildDecision(
    ctx,
    config,
    'allowed_current_brain_canonical_live',
    true,
    side,
    leverage,
    positionFraction,
  );
}

export function shouldEnterStackingMomentumLive(
  ctx: AegisMicroLiveGateContext,
  config: AegisMicroLiveGateConfig,
  side: 'LONG' | 'SHORT',
): AegisMicroLiveGateDecision {
  if (config.tradingMode !== 'AEGIS_TURBO_MICRO_LIVE')
    return buildDecision(ctx, config, 'trading_mode_not_turbo_micro_live');
  if (config.liveEnabled !== true) return buildDecision(ctx, config, 'aegis_live_disabled');
  if (config.yamlEnabled === false) return buildDecision(ctx, config, 'aegis_turbo_yaml_disabled');
  if (config.yamlEnabled === true && config.yamlLiveEnabled !== true)
    return buildDecision(ctx, config, 'aegis_turbo_yaml_live_disabled');

  const operationalSafety = evaluateOperationalSafety(ctx, config);
  if (!operationalSafety.allowed) return buildDecision(ctx, config, operationalSafety.reason);

  if (side === 'SHORT' && config.allowShort !== true)
    return buildDecision(ctx, config, 'short_disabled');
  return buildDecision(
    ctx,
    config,
    'allowed_main_stacking_momentum_replica',
    true,
    side,
    Math.min(DEFAULT_LEVERAGE, config.leverageCap),
    Math.min(DEFAULT_POSITION_FRACTION, config.positionFractionCap),
  );
}

function finiteConfigNumber(value: unknown): number | undefined {
  return finiteNumber(value) ? value : undefined;
}

export function buildAegisMicroLiveGateConfigFromEnv(
  CONFIG: any,
  yamlTurboConfig?: any,
  regimeConfig?: {
    leverage?: number;
    entryThreshold?: number;
    hardStopRoe?: number;
    tpRoe?: number;
    trailingActivationRoe?: number;
    trailingCallbackRoe?: number;
  },
): AegisMicroLiveGateConfig {
  const yamlTurbo = yamlTurboConfig ?? {};
  const yamlRegime = regimeConfig ?? {};

  return {
    tradingMode: CONFIG.TRADING_MODE,
    liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
    yamlEnabled: yamlTurbo.enabled ?? false,
    yamlLiveEnabled: yamlTurbo.live_enabled ?? false,
    allowShort: yamlTurbo.allow_short ?? false,
    minScore: finiteConfigNumber(yamlRegime.entryThreshold) ?? DEFAULT_MIN_SCORE,
    leverageCap: finiteConfigNumber(yamlRegime.leverage) ?? DEFAULT_LEVERAGE,
    positionFractionCap:
      finiteConfigNumber(yamlTurbo.position_fraction_cap) ?? DEFAULT_POSITION_FRACTION_CAP,
    maxTradesPerDay: finiteConfigNumber(yamlTurbo.max_trades_per_day) ?? DEFAULT_MAX_TRADES_PER_DAY,
    maxConsecutiveLosses:
      finiteConfigNumber(yamlTurbo.max_consecutive_losses) ?? DEFAULT_MAX_CONSECUTIVE_LOSSES,
    dailyLossStopPct:
      finiteConfigNumber(Math.abs(yamlTurbo.daily_loss_stop_pct)) ?? DEFAULT_DAILY_LOSS_STOP_PCT,
    minCooldownMs: finiteConfigNumber(yamlTurbo.min_cooldown_ms) ?? DEFAULT_MIN_COOLDOWN_MS,
    maxLiquidityStress:
      finiteConfigNumber(yamlTurbo.max_liquidity_stress) ?? DEFAULT_MAX_LIQUIDITY_STRESS,
    stopRoe: normalizeNegative(yamlRegime.hardStopRoe, DEFAULT_STOP_ROE),
    takeProfitRoe: normalizePositive(yamlRegime.tpRoe, DEFAULT_TAKE_PROFIT_ROE),
    trailingActivationRoe: normalizePositive(
      yamlRegime.trailingActivationRoe,
      DEFAULT_TRAILING_ACTIVATION_ROE,
    ),
    trailingCallbackRoe: normalizePositive(
      yamlRegime.trailingCallbackRoe,
      DEFAULT_TRAILING_CALLBACK_ROE,
    ),
    requireBrackets: yamlTurbo.require_brackets ?? true,
    closeIfBracketFails: yamlTurbo.close_if_bracket_fails ?? true,
  };
}
