import { AegisBlock, AegisVotes } from './AegisStrategy';

export interface AegisMicroLiveGateConfig {
  tradingMode: string;
  liveEnabled: boolean;
  allowShort: boolean;
  minScore: number;
  leverageCap: number;
  positionFractionCap: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  dailyLossStopPct: number;
  minCooldownMs: number;
  maxLiquidityStress: number;
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
    stopRoe: normalizeNegative(turbo?.stop_roe, DEFAULT_STOP_ROE),
    takeProfitRoe: normalizePositive(turbo?.take_profit_roe, DEFAULT_TAKE_PROFIT_ROE),
    trailingActivationRoe: normalizePositive(turbo?.trailing_activation_roe, DEFAULT_TRAILING_ACTIVATION_ROE),
    trailingCallbackRoe: normalizePositive(turbo?.trailing_callback_roe, DEFAULT_TRAILING_CALLBACK_ROE),
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
    return buildDecision(ctx, 'trading_mode_not_turbo_micro_live');
  }

  if (config.liveEnabled !== true) {
    return buildDecision(ctx, 'aegis_live_disabled');
  }

  const raw = ctx.signal.aegis?.turbo?.raw;
  if (!raw) {
    return buildDecision(ctx, 'missing_aegis_turbo_raw');
  }

  if (ctx.hasOpenPosition) {
    return buildDecision(ctx, 'position_already_open');
  }

  if (ctx.tradesToday >= config.maxTradesPerDay) {
    return buildDecision(ctx, 'max_trades_per_day_reached');
  }

  if (ctx.consecutiveLosses >= config.maxConsecutiveLosses) {
    return buildDecision(ctx, 'max_consecutive_losses_reached');
  }

  if (ctx.timeSinceLastExitMs < config.minCooldownMs) {
    return buildDecision(ctx, 'cooldown_active');
  }

  if (ctx.liquidityStress > config.maxLiquidityStress) {
    return buildDecision(ctx, 'liquidity_stress_block');
  }

  if (ctx.dailyPnlPct !== undefined && ctx.dailyPnlPct <= -Math.abs(config.dailyLossStopPct)) {
    return buildDecision(ctx, 'daily_loss_stop_reached');
  }

  if (raw.would_execute !== true) {
    return buildDecision(ctx, 'raw_would_execute_false');
  }

  if (raw.action !== 'LONG' && raw.action !== 'SHORT') {
    return buildDecision(ctx, 'raw_action_not_trade');
  }

  if (raw.action === 'SHORT' && config.allowShort !== true) {
    return buildDecision(ctx, 'short_disabled');
  }

  if (!finiteNumber(raw.turbo_score) || raw.turbo_score < config.minScore) {
    return buildDecision(ctx, 'turbo_score_below_threshold');
  }

  if (votesForSide(raw.votes, raw.action) < 2) {
    return buildDecision(ctx, raw.action === 'LONG' ? 'insufficient_long_votes' : 'insufficient_short_votes');
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
    'allowed_aegis_turbo_micro_live',
    true,
    raw.action,
    leverage,
    positionFraction,
  );
}

export function buildAegisMicroLiveGateConfigFromEnv(CONFIG: any): AegisMicroLiveGateConfig {
  return {
    tradingMode: CONFIG.TRADING_MODE,
    liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
    allowShort: CONFIG.AEGIS_TURBO_ALLOW_SHORT,
    minScore: CONFIG.AEGIS_TURBO_MIN_SCORE,
    leverageCap: CONFIG.AEGIS_TURBO_LEVERAGE,
    positionFractionCap: CONFIG.AEGIS_TURBO_POSITION_FRACTION,
    maxTradesPerDay: CONFIG.AEGIS_TURBO_MAX_TRADES_PER_DAY,
    maxConsecutiveLosses: CONFIG.AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES,
    dailyLossStopPct: CONFIG.AEGIS_TURBO_DAILY_LOSS_STOP_PCT,
    minCooldownMs: 15 * 60 * 1000,
    maxLiquidityStress: 0.70,
  };
}
