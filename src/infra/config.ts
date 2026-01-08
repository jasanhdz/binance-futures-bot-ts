import 'dotenv/config';
import { NinjaConfigManager } from '../app/core/NinjaConfigManager';

// ═══════════════════════════════════════════════════════════════════════════
// SYMBOL PARSING (YAML-based)
// ═══════════════════════════════════════════════════════════════════════════

const ninjaConfig = new NinjaConfigManager();
const SYMBOL_LIST = ninjaConfig.getSymbols();
const SYMBOL_ALLOCATIONS: Record<string, number> = ninjaConfig.getSymbolAllocations();

// Fallback to ENV if YAML has no symbols (backwards compatibility)
if (SYMBOL_LIST.length === 0) {
  const rawSymbols = process.env.SYMBOLS || '';
  const tokens = rawSymbols.split(',').map(s => s.trim()).filter(s => s.length > 0);
  for (const token of tokens) {
    const [symRaw, alloc] = token.split(':');
    const symbol = symRaw.trim().toUpperCase();
    if (symbol) {
      SYMBOL_LIST.push(symbol.endsWith('USDT') ? symbol : `${symbol}USDT`);
      if (alloc) {
        const allocNum = Number(alloc);
        if (Number.isFinite(allocNum) && allocNum > 0 && allocNum <= 1) {
          SYMBOL_ALLOCATIONS[symbol] = allocNum;
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_CAPITAL_USAGE = Number(process.env.CAPITAL_USAGE_PCT ?? 0.75);
const DEFAULT_LEVERAGE = Number(process.env.LEVERAGE ?? 10);

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTED CONFIG
// ═══════════════════════════════════════════════════════════════════════════

export const CONFIG = {
  // --- Binance Credentials ---
  API_KEY: process.env.BINANCE_API_KEY || '',
  API_SECRET: process.env.BINANCE_API_SECRET || '',
  IS_TESTNET: process.env.IS_TESTNET === '1',
  HTTP_FUTURES: process.env.IS_TESTNET === '1'
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com',
  WS_FUTURES: process.env.IS_TESTNET === '1'
    ? 'wss://fstream.binancefuture.com'
    : 'wss://fstream.binance.com',

  // --- Bot Timing ---
  BOT_STAGGER_MS: Number(process.env.BOT_STAGGER_MS ?? 2_000),
  BOT_INTERVAL_SEC: Number(process.env.BOT_INTERVAL_SEC ?? 10),

  // --- Symbols & Sizing ---
  SYMBOL: SYMBOL_LIST[0] || DEFAULT_SYMBOL,
  SYMBOLS: SYMBOL_LIST.length ? SYMBOL_LIST : [DEFAULT_SYMBOL],
  SYMBOL_ALLOCATIONS,
  SYMBOL_LEVERAGE: {} as Record<string, number>,  // Populated by NinjaConfigManager per-regime
  SYMBOL_SHARE: DEFAULT_CAPITAL_USAGE,

  LEVERAGE: DEFAULT_LEVERAGE,
  CAPITAL_USAGE_PCT: DEFAULT_CAPITAL_USAGE,
  MIN_WALLET_RESERVE_USDT: Number(process.env.MIN_WALLET_RESERVE_USDT ?? 0),
  FEE_BUFFER_PCT: Number(process.env.FEE_BUFFER_PCT ?? 0.0004),

  // --- Risk Management ---
  MAX_RISK_PCT: Number(process.env.MAX_RISK_PCT ?? 0),
  LOW_FUNDS_WALLET_THRESHOLD: Number(process.env.LOW_FUNDS_WALLET_THRESHOLD ?? 2),

  // --- ML Service ---
  ML_SERVICE_URL: process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001',
  ML_HISTORY_BARS: Number(process.env.ML_HISTORY_BARS ?? 512),

  // --- Re-entry Logic (Post-Exit Gate) ---
  REENTER_ON_TP: (process.env.REENTER_ON_TP ?? '1') === '1',
  POST_EXIT_TIMEOUT_MS: Number(process.env.POST_EXIT_TIMEOUT_MS ?? 60_000),
  VOL_FACTOR_REENTER: Number(process.env.VOL_FACTOR_REENTER ?? 1.5),
} as const;

export type BotConfig = typeof CONFIG;

