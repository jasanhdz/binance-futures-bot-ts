import 'dotenv/config';
import { NinjaConfigManager } from './ConfigLoader';

// ═══════════════════════════════════════════════════════════════════════════
// YAML CONFIG LOADER
// ═══════════════════════════════════════════════════════════════════════════

const ninjaConfig = new NinjaConfigManager();
const trading = ninjaConfig.trading;

// Only load symbols that have valid models (not vetoed)
const SYMBOL_LIST = ninjaConfig.getActiveSymbols();
const SYMBOL_ALLOCATIONS: Record<string, number> = ninjaConfig.getSymbolAllocations();

// Defaults
const DEFAULT_LEVERAGE = ninjaConfig.system.global_leverage_default ?? 10;

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function csvEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTED CONFIG
// ═══════════════════════════════════════════════════════════════════════════

export const CONFIG = {
  // --- Binance Credentials (ENV, lazy) ---
  get API_KEY() { return process.env.BINANCE_API_KEY || ''; },
  get API_SECRET() { return process.env.BINANCE_API_SECRET || ''; },
  get IS_TESTNET() { return process.env.IS_TESTNET === '1'; },
  get HTTP_FUTURES() {
    return process.env.IS_TESTNET === '1'
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  },
  get WS_FUTURES() {
    return process.env.IS_TESTNET === '1'
      ? 'wss://fstream.binancefuture.com/ws'
      : 'wss://fstream.binancefuture.com/ws';
  },

  // --- Bot Timing (ENV, lazy) ---
  get BOT_STAGGER_MS() { return Number(process.env.BOT_STAGGER_MS ?? 2_000); },
  get BOT_INTERVAL_SEC() { return Number(process.env.BOT_INTERVAL_SEC ?? 10); },

  // --- Symbols & Sizing (YAML) ---
  SYMBOL: SYMBOL_LIST[0] ?? '',
  SYMBOLS: SYMBOL_LIST,
  SYMBOL_ALLOCATIONS,
  SYMBOL_LEVERAGE: {} as Record<string, number>,
  SYMBOL_SHARE: trading.capital_usage_default,

  LEVERAGE: DEFAULT_LEVERAGE,
  CAPITAL_USAGE_PCT: trading.capital_usage_default,
  MIN_WALLET_RESERVE_USDT: trading.min_wallet_reserve_usdt,
  FEE_BUFFER_PCT: trading.fee_buffer_pct,

  // --- Risk Management (YAML) ---
  MAX_RISK_PCT: trading.max_risk_pct,
  LOW_FUNDS_WALLET_THRESHOLD: trading.low_funds_threshold,

  // --- ML Service (ENV, lazy) ---
  get ML_SERVICE_URL() { return process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001'; },
  get ML_HISTORY_BARS() { return Number(process.env.ML_HISTORY_BARS ?? 512); },
  get ML_PREDICT_TIMEOUT_MS() { return numberEnv('ML_PREDICT_TIMEOUT_MS') ?? 12_000; },
  get ML_EXIT_SIGNAL_TIMEOUT_MS() { return numberEnv('ML_EXIT_SIGNAL_TIMEOUT_MS') ?? 8_000; },
  get ML_HEALTH_TIMEOUT_MS() { return numberEnv('ML_HEALTH_TIMEOUT_MS') ?? 3_000; },

  // --- Aegis TS Integration (ENV, lazy) ---
  get TRADING_MODE() { return process.env.TRADING_MODE || 'AEGIS_SHADOW'; },
  get AEGIS_LIVE_ENABLED() { return process.env.AEGIS_LIVE_ENABLED === '1'; },
  get AEGIS_TURBO_ALLOW_SHORT() { return process.env.AEGIS_TURBO_ALLOW_SHORT === '1'; },
  get AEGIS_TURBO_MIN_SCORE() { return numberEnv('AEGIS_TURBO_MIN_SCORE'); },
  get AEGIS_TURBO_LEVERAGE() { return numberEnv('AEGIS_TURBO_LEVERAGE'); },
  get AEGIS_TURBO_POSITION_FRACTION() { return numberEnv('AEGIS_TURBO_POSITION_FRACTION'); },
  get AEGIS_TURBO_MAX_TRADES_PER_DAY() { return numberEnv('AEGIS_TURBO_MAX_TRADES_PER_DAY'); },
  get AEGIS_TURBO_DAILY_LOSS_STOP_PCT() { return numberEnv('AEGIS_TURBO_DAILY_LOSS_STOP_PCT'); },
  get AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES() { return numberEnv('AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES'); },

  // --- Telegram inbound commands (ENV, lazy) ---
  get TELEGRAM_COMMANDS_ENABLED() { return process.env.TELEGRAM_COMMANDS_ENABLED === '1'; },
  get TELEGRAM_ALLOWED_CHAT_IDS() {
    return csvEnv('TELEGRAM_ALLOWED_CHAT_IDS').length > 0
      ? csvEnv('TELEGRAM_ALLOWED_CHAT_IDS')
      : csvEnv('TELEGRAM_CHAT_ID');
  },
  get TELEGRAM_ALLOWED_USER_IDS() { return csvEnv('TELEGRAM_ALLOWED_USER_IDS'); },
  get TELEGRAM_POLICY_MUTATIONS_ENABLED() { return process.env.TELEGRAM_POLICY_MUTATIONS_ENABLED === '1'; },

  // --- Re-entry Logic (YAML) ---
  REENTER_ON_TP: trading.reenter_on_tp,
  POST_EXIT_TIMEOUT_MS: trading.post_exit_timeout_ms,
  VOL_FACTOR_REENTER: trading.vol_factor_reenter,
};

export type BotConfig = typeof CONFIG;
