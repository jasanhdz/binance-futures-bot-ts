import { AegisBlock, AegisVotes } from './AegisStrategy';

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
}

const DEFAULT_LEVERAGE = 15;
const DEFAULT_POSITION_FRACTION = 0.08;
const DEFAULT_MIN_SCORE = 0.50;
const DEFAULT_MAX_TRADES_PER_DAY = 2;
const DEFAULT_MAX_CONSECUTIVE_LOSSES = 2;
const DEFAULT_DAILY_LOSS_STOP_PCT = 0.10;
const DEFAULT_MIN_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_MAX_LIQUIDITY_STRESS = 0.70;
const DEFAULT_STOP_ROE = -0.15;
const DEFAULT_TAKE_PROFIT_ROE = 0.25;
const DEFAULT_TRAILING_ACTIVATION_ROE = 0.15;
const DEFAULT_TRAILING_CALLBACK_ROE = 0.08;
const HARD_LEVERAGE_CAP = 15;
const HARD_POSITION_FRACTION_CAP = 0.10;

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
    trailingActivationRoe: normalizePositive(config.trailingActivationRoe, DEFAULT_TRAILING_ACTIVATION_ROE),
    trailingCallbackRoe: normalizePositive(config.trailingCallbackRoe, DEFAULT_TRAILING_CALLBACK_ROE),
    turboScore: raw?.turbo_score,
    votes: raw?.votes,
    rawReason: raw?.reason,
    gatedReason: gated?.reason,
    gatedBlockedBy: gated?.blocked_by,
  };
}

function votesForSide(votes: AegisVotes | undefined, side: 'LONG' | 'SHORT'): number {
  return side === 'LONG' ? votes?.long ?? 0 : votes?.short ?? 0;
}

export function shouldEnterAegisTurboMicroLive(
  ctx: AegisMicroLiveGateContext,
  config: AegisMicroLiveGateConfig
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

  const raw = ctx.signal.aegis?.turbo?.raw;
  if (!raw) {
    return buildDecision(ctx, config, 'missing_aegis_turbo_raw');
  }

  if (ctx.hasOpenPosition) {
    return buildDecision(ctx, config, 'position_already_open');
  }

  if (ctx.tradesToday >= config.maxTradesPerDay) {
    return buildDecision(ctx, config, 'max_trades_per_day_reached');
  }

  if (ctx.consecutiveLosses >= config.maxConsecutiveLosses) {
    return buildDecision(ctx, config, 'max_consecutive_losses_reached');
  }

  if (ctx.timeSinceLastExitMs < config.minCooldownMs) {
    return buildDecision(ctx, config, 'cooldown_active');
  }

  if (ctx.liquidityStress > config.maxLiquidityStress) {
    return buildDecision(ctx, config, 'liquidity_stress_block');
  }

  if (ctx.dailyPnlPct !== undefined && ctx.dailyPnlPct <= -Math.abs(config.dailyLossStopPct)) {
    return buildDecision(ctx, config, 'daily_loss_stop_reached');
  }

  if (raw.would_execute !== true) {
    return buildDecision(ctx, config, 'raw_would_execute_false');
  }

  if (raw.action !== 'LONG' && raw.action !== 'SHORT') {
    return buildDecision(ctx, config, 'raw_action_not_trade');
  }

  if (raw.action === 'SHORT' && config.allowShort !== true) {
    return buildDecision(ctx, config, 'short_disabled');
  }

  if (!finiteNumber(raw.turbo_score) || raw.turbo_score < config.minScore) {
    return buildDecision(ctx, config, 'turbo_score_below_threshold');
  }

  if (votesForSide(raw.votes, raw.action) < 2) {
    return buildDecision(ctx, config, raw.action === 'LONG' ? 'insufficient_long_votes' : 'insufficient_short_votes');
  }

  const leverage = Math.min(
    raw.leverage_suggestion || DEFAULT_LEVERAGE,
    config.leverageCap,
    HARD_LEVERAGE_CAP,
  );
  const positionFraction = Math.min(
    raw.position_fraction || DEFAULT_POSITION_FRACTION,
    config.positionFractionCap,
    HARD_POSITION_FRACTION_CAP,
  );

  return buildDecision(
    ctx,
    config,
    'allowed_aegis_turbo_micro_live',
    true,
    raw.action,
    leverage,
    positionFraction,
  );
}

function finiteConfigNumber(value: unknown): number | undefined {
  return finiteNumber(value) ? value : undefined;
}

function minDefined(...values: Array<number | undefined>): number {
  return Math.min(...values.filter((value): value is number => value !== undefined));
}

function maxDefined(...values: Array<number | undefined>): number {
  return Math.max(...values.filter((value): value is number => value !== undefined));
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
  }
): AegisMicroLiveGateConfig {
  const envMinScore = finiteConfigNumber(CONFIG.AEGIS_TURBO_MIN_SCORE);
  const envLeverageCap = finiteConfigNumber(CONFIG.AEGIS_TURBO_LEVERAGE);
  const envPositionFractionCap = finiteConfigNumber(CONFIG.AEGIS_TURBO_POSITION_FRACTION);
  const envMaxTrades = finiteConfigNumber(CONFIG.AEGIS_TURBO_MAX_TRADES_PER_DAY);
  const envMaxLosses = finiteConfigNumber(CONFIG.AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES);
  const envDailyLoss = finiteConfigNumber(Math.abs(CONFIG.AEGIS_TURBO_DAILY_LOSS_STOP_PCT));

  return {
    tradingMode: CONFIG.TRADING_MODE,
    liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
    yamlEnabled: yamlTurboConfig?.enabled,
    yamlLiveEnabled: yamlTurboConfig?.live_enabled,
    allowShort: CONFIG.AEGIS_TURBO_ALLOW_SHORT && yamlTurboConfig?.allow_short === true,
    minScore: maxDefined(envMinScore, finiteConfigNumber(regimeConfig?.entryThreshold), DEFAULT_MIN_SCORE),
    leverageCap: minDefined(envLeverageCap, finiteConfigNumber(regimeConfig?.leverage), HARD_LEVERAGE_CAP),
    positionFractionCap: minDefined(envPositionFractionCap, finiteConfigNumber(yamlTurboConfig?.position_fraction_cap), HARD_POSITION_FRACTION_CAP),
    maxTradesPerDay: minDefined(envMaxTrades, finiteConfigNumber(yamlTurboConfig?.max_trades_per_day), DEFAULT_MAX_TRADES_PER_DAY),
    maxConsecutiveLosses: minDefined(envMaxLosses, finiteConfigNumber(yamlTurboConfig?.max_consecutive_losses), DEFAULT_MAX_CONSECUTIVE_LOSSES),
    dailyLossStopPct: minDefined(envDailyLoss, finiteConfigNumber(Math.abs(yamlTurboConfig?.daily_loss_stop_pct)), DEFAULT_DAILY_LOSS_STOP_PCT),
    minCooldownMs: finiteConfigNumber(yamlTurboConfig?.min_cooldown_ms) ?? DEFAULT_MIN_COOLDOWN_MS,
    maxLiquidityStress: minDefined(DEFAULT_MAX_LIQUIDITY_STRESS, finiteConfigNumber(yamlTurboConfig?.max_liquidity_stress)),
    stopRoe: normalizeNegative(regimeConfig?.hardStopRoe, DEFAULT_STOP_ROE),
    takeProfitRoe: normalizePositive(regimeConfig?.tpRoe, DEFAULT_TAKE_PROFIT_ROE),
    trailingActivationRoe: normalizePositive(regimeConfig?.trailingActivationRoe, DEFAULT_TRAILING_ACTIVATION_ROE),
    trailingCallbackRoe: normalizePositive(regimeConfig?.trailingCallbackRoe, DEFAULT_TRAILING_CALLBACK_ROE),
    requireBrackets: yamlTurboConfig?.require_brackets,
    closeIfBracketFails: yamlTurboConfig?.close_if_bracket_fails,
  };
}
