import type { SuiSrScoutConfig, ExecutionMode, ScoutSymbol } from '../domain/ScoutTypes';
import { TRADEABLE_SYMBOL, CONTEXT_SYMBOL } from '../domain/ScoutTypes';

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true';
}

function envExecutionMode(key: string, fallback: ExecutionMode): ExecutionMode {
  const raw = process.env[key];
  if (raw === 'OBSERVE' || raw === 'LIVE_CANARY') return raw;
  return fallback;
}

const REQUIRED_LIVE_KEYS = [
  'SUI_SR_SCOUT_MAX_QUOTE_NOTIONAL',
  'SUI_SR_SCOUT_MAX_LEVERAGE',
  'SUI_SR_SCOUT_MAX_RISK_PER_TRADE_BPS',
  'SUI_SR_SCOUT_MAX_DAILY_LOSS_BPS',
  'SUI_SR_SCOUT_COOLDOWN_AFTER_STOP_MS',
] as const;

export function loadSuiSrScoutConfig(): SuiSrScoutConfig {
  const executionMode = envExecutionMode('SUI_SR_SCOUT_EXECUTION_MODE', 'OBSERVE');
  const liveEnabled = envBool('SUI_SR_SCOUT_LIVE_ENABLED', false);
  const symbol = envStr('SUI_SR_SCOUT_SYMBOL', TRADEABLE_SYMBOL) as ScoutSymbol;
  const contextSymbol = envStr('SUI_SR_SCOUT_CONTEXT_SYMBOL', CONTEXT_SYMBOL) as ScoutSymbol;

  if (executionMode === 'LIVE_CANARY') {
    if (!liveEnabled) {
      throw new Error('SUI_SR_SCOUT_LIVE_ENABLED must be true for LIVE_CANARY mode');
    }
    if (symbol !== TRADEABLE_SYMBOL) {
      throw new Error(
        `SUI_SR_SCOUT_SYMBOL must be ${TRADEABLE_SYMBOL} for LIVE_CANARY, got ${symbol}`,
      );
    }
    for (const key of REQUIRED_LIVE_KEYS) {
      const val = process.env[key];
      if (!val || Number(val) <= 0) {
        throw new Error(`LIVE_CANARY requires ${key} to be a positive number, got "${val ?? ''}"`);
      }
    }
  }

  return {
    enabled: envBool('SUI_SR_SCOUT_ENABLED', false),
    executionMode,
    liveEnabled,
    symbol,
    contextSymbol,
    maxOpenPositions: envNum('SUI_SR_SCOUT_MAX_OPEN_POSITIONS', 1),
    maxQuoteNotional: envNum('SUI_SR_SCOUT_MAX_QUOTE_NOTIONAL', 0),
    maxLeverage: envNum('SUI_SR_SCOUT_MAX_LEVERAGE', 0),
    maxRiskPerTradeBps: envNum('SUI_SR_SCOUT_MAX_RISK_PER_TRADE_BPS', 0),
    maxDailyLossBps: envNum('SUI_SR_SCOUT_MAX_DAILY_LOSS_BPS', 0),
    cooldownAfterStopMs: envNum('SUI_SR_SCOUT_COOLDOWN_AFTER_STOP_MS', 0),
    minNetRMultiple: envNum('SUI_SR_SCOUT_MIN_NET_R_MULTIPLE', 1.5),
    tickIntervalMs: envNum('SUI_SR_SCOUT_TICK_INTERVAL_MS', 100),
    feedStaleThresholdMs: envNum('SUI_SR_SCOUT_FEED_STALE_MS', 5000),
    feedGapThresholdMs: envNum('SUI_SR_SCOUT_FEED_GAP_MS', 2000),
    candleIntervals: ['1m', '3m'],
    srZoneAtrTolerance: envNum('SUI_SR_SCOUT_SR_ATR_TOLERANCE', 0.15),
    srMinTouchCount: envNum('SUI_SR_SCOUT_SR_MIN_TOUCHES', 2),
    srZoneScoreMin: envNum('SUI_SR_SCOUT_SR_ZONE_SCORE_MIN', 0.4),
    breakConfirmationCandles: envNum('SUI_SR_SCOUT_BREAK_CONFIRM_CANDLES', 2),
    btcAggressiveThreshold: envNum('SUI_SR_SCOUT_BTC_AGGRESSIVE_THRESHOLD', 0.65),
    killSwitch: envBool('SUI_SR_SCOUT_KILL_SWITCH', true),
  };
}

export function validateConfig(cfg: SuiSrScoutConfig): string[] {
  const errors: string[] = [];
  if (cfg.symbol !== TRADEABLE_SYMBOL) {
    errors.push(`symbol must be ${TRADEABLE_SYMBOL}`);
  }
  if (cfg.contextSymbol !== CONTEXT_SYMBOL) {
    errors.push(`contextSymbol must be ${CONTEXT_SYMBOL}`);
  }
  if (cfg.maxOpenPositions < 0) {
    errors.push('maxOpenPositions must be >= 0');
  }
  if (cfg.feedStaleThresholdMs <= 0) {
    errors.push('feedStaleThresholdMs must be > 0');
  }
  if (cfg.feedGapThresholdMs <= 0) {
    errors.push('feedGapThresholdMs must be > 0');
  }
  if (cfg.minNetRMultiple <= 0) {
    errors.push('minNetRMultiple must be > 0');
  }
  return errors;
}
