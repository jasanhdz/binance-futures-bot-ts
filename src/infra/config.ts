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

// --- Symbol Parsing Logic ---
type SymbolDescriptor = { symbol: string; leverage?: number; capitalUsage?: number };
const rawSymbols = process.env.SYMBOLS || '';
const tokens = rawSymbols.split(',').map(s => s.trim()).filter(s => s.length > 0);
const descriptors: SymbolDescriptor[] = [];
const seen = new Map<string, number>();

for (const token of tokens) {
    const [symRaw, part1, part2] = token.split(':');
    const symbol = normalizeSymbol(symRaw);
    if (!symbol) continue;

    let leverage: number | undefined;
    let capitalUsage: number | undefined;

    if (part2 !== undefined) {
      leverage = parsePositiveNumber(part1);
      capitalUsage = parseShare(part2);
    } else if (part1 !== undefined) {
      const shareCandidate = parseShare(part1);
      if (shareCandidate !== undefined && shareCandidate <= 1) {
        capitalUsage = shareCandidate;
      } else {
        leverage = parsePositiveNumber(part1);
      }
    }
    
    if (seen.has(symbol)) {
        const idx = seen.get(symbol)!;
        if (leverage !== undefined) descriptors[idx].leverage = leverage;
        if (capitalUsage !== undefined) descriptors[idx].capitalUsage = capitalUsage;
    } else {
        seen.set(symbol, descriptors.length);
        descriptors.push({ symbol, leverage, capitalUsage });
    }
}

const SYMBOL_LIST = descriptors.map(d => d.symbol);
const SYMBOL_ALLOCATIONS: Record<string, number> = {};
const SYMBOL_LEVERAGE: Record<string, number> = {};

for (const desc of descriptors) {
    if (desc.leverage) SYMBOL_LEVERAGE[desc.symbol] = desc.leverage;
    if (desc.capitalUsage) SYMBOL_ALLOCATIONS[desc.symbol] = desc.capitalUsage;
}

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
  ENTRY_TIMEFRAME: (process.env.ENTRY_TIMEFRAME as '1m' | '3m' | '5m' | '15m' | '1h') || '1h',
  ML_HISTORY_BARS: Number(process.env.ML_HISTORY_BARS ?? 512),
  
  // --- Re-entry logic (Post-Exit Gate) ---
  REENTER_ON_TP: (process.env.REENTER_ON_TP ?? '1') === '1',
  POST_EXIT_PULLBACK_PCT: Number(process.env.POST_EXIT_PULLBACK_PCT ?? 0.006),
  POST_EXIT_REBOUND_PCT: Number(process.env.POST_EXIT_REBOUND_PCT ?? 0.35),
  POST_EXIT_BREAKOUT_PCT: Number(process.env.POST_EXIT_BREAKOUT_PCT ?? 0.0015),
  POST_EXIT_TIMEOUT_MS: Number(process.env.POST_EXIT_TIMEOUT_MS ?? 300_000),
  POST_EXIT_BREAKOUT_VOL_FACTOR: Number(process.env.POST_EXIT_BREAKOUT_VOL_FACTOR ?? 1.3),
  VOL_FACTOR_REENTER: Number(process.env.VOL_FACTOR_REENTER ?? 1.5), // Fallback used in logic
  
  // --- Symbol Allocations ---
  SYMBOL_ALLOCATIONS,
  SYMBOL_LEVERAGE,
  SYMBOL_SHARE: DEFAULT_CAPITAL_USAGE, // Fallback
} as const;

export type BotConfig = typeof CONFIG;
