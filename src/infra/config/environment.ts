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
const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_LEVERAGE = ninjaConfig.system.global_leverage_default || 10;

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTED CONFIG
// ═══════════════════════════════════════════════════════════════════════════

export const CONFIG = {
  // --- Binance Credentials (ENV) ---
  API_KEY: process.env.BINANCE_API_KEY || '',
  API_SECRET: process.env.BINANCE_API_SECRET || '',
  IS_TESTNET: process.env.IS_TESTNET === '1',
  HTTP_FUTURES: process.env.IS_TESTNET === '1'
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com',
  WS_FUTURES: process.env.IS_TESTNET === '1'
    ? 'wss://fstream.binancefuture.com/ws'
    : 'wss://fstream.binancefuture.com/ws',

  // --- Bot Timing (ENV) ---
  BOT_STAGGER_MS: Number(process.env.BOT_STAGGER_MS ?? 2_000),
  BOT_INTERVAL_SEC: Number(process.env.BOT_INTERVAL_SEC ?? 10),

  // --- Symbols & Sizing (YAML) ---
  SYMBOL: SYMBOL_LIST[0] || DEFAULT_SYMBOL,
  SYMBOLS: SYMBOL_LIST.length ? SYMBOL_LIST : [DEFAULT_SYMBOL],
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

  // --- ML Service (ENV) ---
  ML_SERVICE_URL: process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001',
  ML_HISTORY_BARS: Number(process.env.ML_HISTORY_BARS ?? 512),

  // --- Re-entry Logic (YAML) ---
  REENTER_ON_TP: trading.reenter_on_tp,
  POST_EXIT_TIMEOUT_MS: trading.post_exit_timeout_ms,
  VOL_FACTOR_REENTER: trading.vol_factor_reenter,
} as const;

export type BotConfig = typeof CONFIG;

