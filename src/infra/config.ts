import 'dotenv/config';

const QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'USD', 'BTC', 'ETH', 'PERP'];

function normalizeSymbol(raw?: string): string {
  if (!raw) return '';
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleaned) return '';
  if (QUOTE_SUFFIXES.some((suffix) => cleaned.endsWith(suffix))) return cleaned;
  if (cleaned.includes('USDT')) return cleaned;
  return `${cleaned}USDT`;
}

function clampShare(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function parseShare(raw?: string): number | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.replace('%', '').trim();
  if (!cleaned) return undefined;
  let num = Number(cleaned);
  if (!Number.isFinite(num)) return undefined;
  if (num > 1) num = num / 100;
  return clampShare(num);
}

function parsePositiveNumber(raw?: string): number | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.trim();
  if (!cleaned) return undefined;
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return num;
}

function parseSymbolList(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => normalizeSymbol(s)).filter((s) => s.length > 0);
}

// --- Symbol Parsing Logic (YAML-based) ---
import { NinjaConfigManager } from '../app/core/NinjaConfigManager';

// Load symbols from YAML config
const ninjaConfig = new NinjaConfigManager();
const SYMBOL_LIST = ninjaConfig.getSymbols();
const SYMBOL_ALLOCATIONS: Record<string, number> = ninjaConfig.getSymbolAllocations();

// Fallback to ENV if YAML has no symbols (backwards compatibility)
if (SYMBOL_LIST.length === 0) {
  const rawSymbols = process.env.SYMBOLS || '';
  const tokens = rawSymbols.split(',').map(s => s.trim()).filter(s => s.length > 0);
  for (const token of tokens) {
    const [symRaw, alloc] = token.split(':');
    const symbol = normalizeSymbol(symRaw);
    if (symbol) {
      SYMBOL_LIST.push(symbol);
      if (alloc) {
        const allocNum = parseShare(alloc);
        if (allocNum !== undefined) SYMBOL_ALLOCATIONS[symbol] = allocNum;
      }
    }
  }
}

// Legacy maps (for backwards compatibility)
const SYMBOL_LEVERAGE: Record<string, number> = {};

// --- Defaults ---
const defaultSymbol = normalizeSymbol(process.env.SYMBOL || 'XRPUSDT') || 'XRPUSDT';
const DEFAULT_CAPITAL_USAGE = Number(process.env.CAPITAL_USAGE_PCT ?? 0.85);
const DEFAULT_LEVERAGE = Number(process.env.LEVERAGE ?? 5);

export const CONFIG = {
  // --- Credenciales / endpoints ---
  API_KEY: process.env.BINANCE_API_KEY || '',
  API_SECRET: process.env.BINANCE_API_SECRET || '',
  IS_TESTNET: process.env.IS_TESTNET === '1',
  HTTP_FUTURES: process.env.IS_TESTNET === '1' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com',
  WS_FUTURES: process.env.IS_TESTNET === '1' ? 'wss://fstream.binancefuture.com' : 'wss://fstream.binance.com',

  BOT_STAGGER_MS: Number(process.env.BOT_STAGGER_MS ?? 2_000),
  BOT_INTERVAL_SEC: Number(process.env.BOT_INTERVAL_SEC ?? 5),

  // --- Mercado / sizing ---
  SYMBOL: defaultSymbol,
  SYMBOLS: SYMBOL_LIST.length ? SYMBOL_LIST : [defaultSymbol],
  LEVERAGE: DEFAULT_LEVERAGE,
  CAPITAL_USAGE_PCT: DEFAULT_CAPITAL_USAGE,
  MIN_WALLET_RESERVE_USDT: Number(process.env.MIN_WALLET_RESERVE_USDT ?? 0.1),
  FEE_BUFFER_PCT: Number(process.env.FEE_BUFFER_PCT ?? 0.001),

  // --- Risk ---
  MAX_RISK_PCT: Number(process.env.MAX_RISK_PCT ?? 0),
  LOW_FUNDS_WALLET_THRESHOLD: Number(process.env.LOW_FUNDS_WALLET_THRESHOLD ?? 0.2),
  DAILY_DD_MAX_PCT: Number(process.env.DAILY_DD_MAX_PCT ?? 0),
  ATR_LEN: 14, // Used by StrategyRunner for SL

  // --- ML Config ---
  ML_SERVICE_URL: process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000',
  ML_HISTORY_BARS: Number(process.env.ML_HISTORY_BARS ?? 512),

  // --- Re-entry logic (Post-Exit Gate) ---
  REENTER_ON_TP: (process.env.REENTER_ON_TP ?? '1') === '1',
  POST_EXIT_PULLBACK_PCT: Number(process.env.POST_EXIT_PULLBACK_PCT ?? 0.006),
  POST_EXIT_REBOUND_PCT: Number(process.env.POST_EXIT_REBOUND_PCT ?? 0.35),
  POST_EXIT_BREAKOUT_PCT: Number(process.env.POST_EXIT_BREAKOUT_PCT ?? 0.0015),
  POST_EXIT_TIMEOUT_MS: Number(process.env.POST_EXIT_TIMEOUT_MS ?? 300_000),
  POST_EXIT_BREAKOUT_VOL_FACTOR: Number(process.env.POST_EXIT_BREAKOUT_VOL_FACTOR ?? 1.3),
  VOL_FACTOR_REENTER: Number(process.env.VOL_FACTOR_REENTER ?? 1.5), // Fallback used in logic

  // --- Stops iniciales (Legacy brackets guard) ---
  SL_TICKS_ABOVE_LIQ_MAP: {
    XRPUSDT: 69,
    ETHUSDT: 8,
    BTCUSDT: 50,
  } as Record<string, number>,
  SL_TICKS_ABOVE_LIQ_DEFAULT: Number(process.env.SL_TICKS_ABOVE_LIQ_DEFAULT ?? 69),
  STOP_LIQ_BUFFER_RATIO: Number(process.env.STOP_LIQ_BUFFER_RATIO ?? 0.08),
  TP_ROE: Number(process.env.TP_ROE ?? 1.0),

  // --- Symbol Allocations ---
  SYMBOL_ALLOCATIONS,
  SYMBOL_LEVERAGE,
  SYMBOL_SHARE: DEFAULT_CAPITAL_USAGE, // Fallback
} as const;

export type BotConfig = typeof CONFIG;
