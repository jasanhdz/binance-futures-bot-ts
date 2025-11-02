// src/infra/config.ts
const defaultSymbol = (process.env.SYMBOL || 'XRPUSDT').toUpperCase();
const DEFAULT_CAPITAL_USAGE = Number(process.env.CAPITAL_USAGE_PCT ?? 0.85);
const DEFAULT_LEVERAGE = Number(process.env.LEVERAGE ?? 100);

type SymbolDescriptor = {
  symbol: string;
  leverage?: number;
  capitalUsage?: number;
};

type AllocationMap = Record<string, number>;

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

function parseSymbolDescriptors(): SymbolDescriptor[] {
  const raw = process.env.SYMBOLS;
  const tokens = raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  const descriptors: SymbolDescriptor[] = [];
  const seen = new Map<string, number>(); // symbol -> index

  const upsert = (desc: SymbolDescriptor) => {
    const symbol = desc.symbol;
    if (!symbol) return;
    const idx = seen.get(symbol);
    if (idx !== undefined) {
      const curr = descriptors[idx];
      if (desc.leverage !== undefined) curr.leverage = desc.leverage;
      if (desc.capitalUsage !== undefined) curr.capitalUsage = desc.capitalUsage;
      return;
    }
    seen.set(symbol, descriptors.length);
    descriptors.push(desc);
  };

  for (const token of tokens) {
    const [symRaw, part1, part2] = token.split(':');
    const symbol = (symRaw ?? '').trim().toUpperCase();
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

    if (part1 === '' && part2 !== undefined && capitalUsage === undefined) {
      capitalUsage = parseShare(part2);
    }

    upsert({
      symbol,
      leverage,
      capitalUsage,
    });
  }

  return descriptors;
}

function parseAllocationOverrides(symbols: string[]): AllocationMap {
  const map: AllocationMap = {};
  const raw = process.env.SYMBOL_ALLOCATIONS;
  if (!raw) return map;

  const parts = raw
    .split(/[,;]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  for (const part of parts) {
    const [symbolRaw, valueRaw] = part.split(/[:=]/, 2);
    if (!symbolRaw || !valueRaw) continue;
    const sym = symbolRaw.trim().toUpperCase();
    const share = parseShare(valueRaw);
    if (share === undefined) continue;
    map[sym] = share;
  }
  return map;
}

const SYMBOL_DESCRIPTORS = parseSymbolDescriptors();
console.log('Parsed symbol descriptors:', SYMBOL_DESCRIPTORS);
const SYMBOL_LIST = SYMBOL_DESCRIPTORS.map((d) => d.symbol);
function parseSymbolList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

const SCAN_SYMBOLS_LIST = Array.from(new Set(parseSymbolList(process.env.SCAN_SYMBOLS ?? '')));
const PRIMARY_SYMBOL = SYMBOL_LIST[0] ?? defaultSymbol;

const SYMBOL_ALLOCATIONS: AllocationMap = {};
const SYMBOL_LEVERAGE: Record<string, number> = {};

const allocationOverrides = parseAllocationOverrides(SYMBOL_LIST);

for (const desc of SYMBOL_DESCRIPTORS) {
  if (desc.leverage !== undefined) {
    SYMBOL_LEVERAGE[desc.symbol] = desc.leverage;
  }
  if (desc.capitalUsage !== undefined) {
    SYMBOL_ALLOCATIONS[desc.symbol] = clampShare(desc.capitalUsage);
  }
}

for (const sym of SYMBOL_LIST) {
  if (allocationOverrides[sym] !== undefined) {
    SYMBOL_ALLOCATIONS[sym] = allocationOverrides[sym];
  }
  if (SYMBOL_ALLOCATIONS[sym] === undefined) {
    SYMBOL_ALLOCATIONS[sym] = 0;
  }
}

const PRIMARY_SYMBOL_SHARE =
  SYMBOL_ALLOCATIONS[PRIMARY_SYMBOL] && SYMBOL_ALLOCATIONS[PRIMARY_SYMBOL] > 0
    ? SYMBOL_ALLOCATIONS[PRIMARY_SYMBOL]
    : DEFAULT_CAPITAL_USAGE;

export const CONFIG = {
  // --- Credenciales / endpoints ---
  API_KEY: process.env.BINANCE_API_KEY || '',
  API_SECRET: process.env.BINANCE_API_SECRET || '',
  IS_TESTNET: process.env.IS_TESTNET === '1',
  HTTP_FUTURES:
    process.env.IS_TESTNET === '1'
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com',
  WS_FUTURES:
    process.env.IS_TESTNET === '1'
      ? 'wss://fstream.binancefuture.com'
      : 'wss://fstream.binance.com',

  BOT_STAGGER_MS: Number(process.env.BOT_STAGGER_MS ?? 2_000),
  BOT_INTERVAL_SEC: Number(process.env.BOT_INTERVAL_SEC ?? 10),

  // --- Mercado / sizing ---
  SYMBOL: PRIMARY_SYMBOL,
  SYMBOLS: SYMBOL_LIST,
  SCAN_SYMBOLS: SCAN_SYMBOLS_LIST,
  SYMBOL_DESCRIPTORS,
  SYMBOL_ALLOCATIONS,
  SYMBOL_LEVERAGE,
  SYMBOL_SHARE: PRIMARY_SYMBOL_SHARE,
  LEVERAGE: DEFAULT_LEVERAGE,
  CAPITAL_USAGE_PCT: DEFAULT_CAPITAL_USAGE,
  MIN_WALLET_RESERVE_USDT: Number(process.env.MIN_WALLET_RESERVE_USDT ?? 0.1),
  FEE_BUFFER_PCT: Number(process.env.FEE_BUFFER_PCT ?? 0.001),

  // --- Take-profit por ROE ---
  TP_ROE: Number(process.env.TP_ROE ?? 1.0),
  INT_TP_MIN_ROE: Number(process.env.INT_TP_MIN_ROE ?? 0.2),
  INT_TP_TRAIL_DROP: Number(process.env.INT_TP_TRAIL_DROP ?? 0.35),
  INT_TP_TREND_ADX: Number(process.env.INT_TP_TREND_ADX ?? 18),
  INT_TP_LOOKBACK: Number(process.env.INT_TP_LOOKBACK ?? 40),
  INT_TP_COOLDOWN_MS: Number(process.env.INT_TP_COOLDOWN_MS ?? 15_000),

  // --- Timeframes / volumen para señales ---
  ENTRY_TIMEFRAME: (process.env.ENTRY_TIMEFRAME as '1m' | '3m' | '5m' | '15m' | '1h') || '5m',
  VOL_AVG_LEN: Number(process.env.VOL_AVG_LEN ?? 20),
  VOL_FACTOR_ENTRY: Number(process.env.VOL_FACTOR_ENTRY ?? 1.1),

  // --- Rachas mínimas ---
  GREEN_STREAK_MIN: Number(process.env.GREEN_STREAK_MIN ?? 3),
  RED_STREAK_MIN: Number(process.env.RED_STREAK_MIN ?? 3),

  // --- Defensa de “extensión EMA” (apagada) ---
  ENTRY_EMA_PERIOD: Number(process.env.ENTRY_EMA_PERIOD ?? 20),
  ENTRY_MAX_EMA_EXTENSION: Number(process.env.ENTRY_MAX_EMA_EXTENSION ?? 9), // alto → no bloquea

  // --- ML gate + re-entradas ---
  ML_THRESHOLD: Number(process.env.ML_THRESHOLD ?? 0.7),
  REENTER_ON_TP: (process.env.REENTER_ON_TP ?? '1') === '1',
  REENTER_COOLDOWN_MS: Number(process.env.REENTER_COOLDOWN_MS ?? 5_000),
  VOL_FACTOR_REENTER: Number(process.env.VOL_FACTOR_REENTER ?? 1.5),
  GREEN_STREAK_REENTER_MIN: Number(process.env.GREEN_STREAK_REENTER_MIN ?? 2),
  RED_STREAK_REENTER_MIN: Number(process.env.RED_STREAK_REENTER_MIN ?? 2),
  POST_EXIT_PULLBACK_PCT: Number(process.env.POST_EXIT_PULLBACK_PCT ?? 0.006),
  POST_EXIT_REBOUND_PCT: Number(process.env.POST_EXIT_REBOUND_PCT ?? 0.35),
  POST_EXIT_BREAKOUT_PCT: Number(process.env.POST_EXIT_BREAKOUT_PCT ?? 0.0015),
  POST_EXIT_TIMEOUT_MS: Number(process.env.POST_EXIT_TIMEOUT_MS ?? 300_000),
  POST_EXIT_BREAKOUT_VOL_FACTOR: Number(process.env.POST_EXIT_BREAKOUT_VOL_FACTOR ?? 1.3),

  // --- Stops iniciales ---
  SL_TICKS_ABOVE_LIQ_MAP: {
    XRPUSDT: 69,
    ETHUSDT: 8,
    BTCUSDT: 50,
  } as Record<string, number>,
  SL_TICKS_ABOVE_LIQ_DEFAULT: Number(process.env.SL_TICKS_ABOVE_LIQ_DEFAULT ?? 69),
  STOP_LIQ_BUFFER_RATIO: Number(process.env.STOP_LIQ_BUFFER_RATIO ?? 0.08),

  // --- Guards de beneficio / seguridad ---
  PROFIT_LOCK_BE_AT_ROE: Number(process.env.PROFIT_LOCK_BE_AT_ROE ?? 0.2),
  PROFIT_GIVEBACK_ARM_ROE: Number(process.env.PROFIT_GIVEBACK_ARM_ROE ?? 0.4),
  PROFIT_GIVEBACK_DROP_REL: Number(process.env.PROFIT_GIVEBACK_DROP_REL ?? 0.3),
  PROFIT_GIVEBACK_DROP_MIN: Number(process.env.PROFIT_GIVEBACK_DROP_MIN ?? 0.1),

  // Early-fail (apagado para réplica)
  EARLY_FAIL_WINDOW_MS: Number(process.env.EARLY_FAIL_WINDOW_MS ?? 12 * 60_000),
  EARLY_FAIL_VOL_FACTOR: Number(process.env.EARLY_FAIL_VOL_FACTOR ?? 1.5),
  SHARP_BODY_PCT: Number(process.env.SHARP_BODY_PCT ?? 0.6),

  // --- Piramidación + trailing ATR (apagado) ---
  PYRAMID_MAX_UNITS: Number(process.env.PYRAMID_MAX_UNITS ?? 3),
  PYRAMID_STEP_ATR: Number(process.env.PYRAMID_STEP_ATR ?? 0.5),
  PYRAMID_UNIT_PCT_OF_ENTRY: Number(process.env.PYRAMID_UNIT_PCT_OF_ENTRY ?? 0.5),
  ATR_LEN: Number(process.env.ATR_LEN ?? 14),
  TRAIL_ATR_MULT_BASE: Number(process.env.TRAIL_ATR_MULT_BASE ?? 2.5),
  TRAIL_ATR_MULT_MIN: Number(process.env.TRAIL_ATR_MULT_MIN ?? 1.2),
  TRAIL_ATR_STEP_ROE: Number(process.env.TRAIL_ATR_STEP_ROE ?? 0.5),
  STOP_MIN_IMPROVE_TICKS: Number(process.env.STOP_MIN_IMPROVE_TICKS ?? 2),

  // --- Time-stop (apagado) ---
  TIME_STOP_MINUTES: Number(process.env.TIME_STOP_MINUTES ?? 0),
  TIME_STOP_MIN_ROE: Number(process.env.TIME_STOP_MIN_ROE ?? 0.05),

  // Trailing throttle
  TRAIL_ATR_MULT: 2.5,
  TRAIL_THROTTLE_MS: 15_000,
  MAX_RISK_PCT: Number(process.env.MAX_RISK_PCT ?? 0),

  // --- Filtros de tendencia (multi-timeframe) ---
  TREND_TIMEFRAMES: (process.env.TREND_TIMEFRAMES || '5m,15m').split(',') as (
    | '5m'
    | '15m'
    | '1h'
  )[],
  EMA_FAST: Number(process.env.EMA_FAST ?? 7),
  EMA_MID: Number(process.env.EMA_MID ?? 25),
  EMA_SLOW: Number(process.env.EMA_SLOW ?? 99),

  // ADX (Wilder)
  ADX_LEN: Number(process.env.ADX_LEN ?? 14),
  ADX_MIN: Number(process.env.ADX_MIN ?? 20), // fuerza mínima de tendencia

  // Extensión y zona de no-trade
  MAX_EXT_FROM_EMA_FAST: Number(process.env.MAX_EXT_FROM_EMA_FAST ?? 0.015), // 1.5%
  NO_TRADE_BAND_AROUND_EMA_SLOW: Number(process.env.NO_TRADE_BAND_AROUND_EMA_SLOW ?? 0.003), // 0.3%

  // ML gate duro
  ML_MIN_PROB: Number(process.env.ML_MIN_PROB ?? 0.7),
  ML_MARGIN: Number(process.env.ML_MARGIN ?? 0.12), // diferencia min vs lado opuesto,
  ML_PRIMARY_MIN_GAP: Number(process.env.ML_PRIMARY_MIN_GAP ?? 0.1),
  ML_GUARD_SCORE_FLIP_THRESHOLD: Number(process.env.ML_GUARD_SCORE_FLIP_THRESHOLD ?? 0.02),
  ML_GUARD_EXIT_EXT_PCT: Number(process.env.ML_GUARD_EXIT_EXT_PCT ?? 0.008),
  ML_GUARD_EXIT_RSI_HIGH: Number(process.env.ML_GUARD_EXIT_RSI_HIGH ?? 70),
  ML_GUARD_EXIT_RSI_LOW: Number(process.env.ML_GUARD_EXIT_RSI_LOW ?? 30),
  ML_GUARD_EXIT_BODY_ATR: Number(process.env.ML_GUARD_EXIT_BODY_ATR ?? 2.0),

  ALLOW_LONGS: true,
  ALLOW_SHORTS: true, // ⟵ apaga shorts por ahora

  // Umbrales ML por lado (asimétricos)
  ML_THRESHOLD_LONG: Number(process.env.ML_THRESHOLD_LONG ?? 0.6),
  ML_THRESHOLD_SHORT: Number(process.env.ML_THRESHOLD_SHORT ?? 0.8),
  ML_HISTORY_BARS: Number(process.env.ML_HISTORY_BARS ?? 512),
  ML_FILTER_LOOKBACK: Number(process.env.ML_FILTER_LOOKBACK ?? 60),
  ML_MAX_EXT_PCT: Number(process.env.ML_MAX_EXT_PCT ?? 0.015),
  ML_MAX_RSI: Number(process.env.ML_MAX_RSI ?? 68),
  ML_MIN_RSI: Number(process.env.ML_MIN_RSI ?? 32),
  ML_MAX_BODY_ATR: Number(process.env.ML_MAX_BODY_ATR ?? 2.5),
  ML_TP_DROP_MIN: Number(process.env.ML_TP_DROP_MIN ?? 0.15),
  ML_TP_DROP_RATIO: Number(process.env.ML_TP_DROP_RATIO ?? 0.35),
  ML_TP_REVERSAL_VOL_FACTOR: Number(process.env.ML_TP_REVERSAL_VOL_FACTOR ?? 1.5),
  ML_TP_REVERSAL_BODY_RATIO: Number(process.env.ML_TP_REVERSAL_BODY_RATIO ?? 0.55),
  ML_MODEL_TIMEFRAME:
    process.env.ML_MODEL_TIMEFRAME ||
    ((process.env.ENTRY_TIMEFRAME as '1m' | '3m' | '5m' | '15m' | '1h') || '5m'),
  ML_SERVICE_URL: process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000',

  // Filtros de tendencia para permitir short
  ADX_MIN_FOR_SHORT: Number(process.env.ADX_MIN_FOR_SHORT ?? 25),
  REQUIRE_BEAR_MA_FOR_SHORT: (process.env.REQUIRE_BEAR_MA_FOR_SHORT ?? '1') === '1',

  // STACK CLASSIC (apagado)
  STACKC_RANGE_FALLBACK: (process.env.STACKC_RANGE_FALLBACK as 'MR' | 'IDLE') ?? 'MR',
  STACKC_VOL_FACTOR: Number(process.env.STACKC_VOL_FACTOR ?? 1.6),
  STACKC_VOL_FACTOR_SHORT: Number(process.env.STACKC_VOL_FACTOR_SHORT ?? 2.1),
  STACKC_GREEN_STREAK: Number(process.env.STACKC_GREEN_STREAK ?? 3),
  STACKC_RED_STREAK: Number(process.env.STACKC_RED_STREAK ?? 4),
  STACKC_BLOCK_TOP: (process.env.STACKC_BLOCK_TOP ?? '0') === '1',
  STACKC_USE_ML: (process.env.STACKC_USE_ML ?? '0') === '1',

  STACKC_TREND_ADX_MIN: Number(process.env.STACKC_TREND_ADX_MIN ?? 22),
  STACKC_RANGE_ADX_MAX: Number(process.env.STACKC_RANGE_ADX_MAX ?? 18),
  STACKC_BB_WIDTH_MAX: Number(process.env.STACKC_BB_WIDTH_MAX ?? 0.025),

  SHORT_CONFIRM_1H: (process.env.SHORT_CONFIRM_1H ?? '1') === '1',
  SHORT_1H_ADX_MIN: Number(process.env.SHORT_1H_ADX_MIN ?? 20),

  // MOMENTUM BREAKOUT
  MOM_CONSEC_MIN: Number(process.env.MOM_CONSEC_MIN ?? 2),
  MOM_CONSEC_MAX: Number(process.env.MOM_CONSEC_MAX ?? 3),
  MOM_VOL_FACTOR: Number(process.env.MOM_VOL_FACTOR ?? 1.5),
  MOM_BODY_PCT_MIN: Number(process.env.MOM_BODY_PCT_MIN ?? 0.55),
  MOM_TREND_ADX_MIN: Number(process.env.MOM_TREND_ADX_MIN ?? 22),
  MOM_TREND_CONFIRM_TF:
    (process.env.MOM_TREND_CONFIRM_TF as '3m' | '5m' | '15m' | '1h') ?? '15m',
  MOM_SR_LOOKBACK: Number(process.env.MOM_SR_LOOKBACK ?? 36),
  MOM_SR_BUFFER: Number(process.env.MOM_SR_BUFFER ?? 0.0015),
  MOM_ROOM_MIN: Number(process.env.MOM_ROOM_MIN ?? 0.003),

  // TREND FOLLOW
  TF_CONFIRM_TF1: (process.env.TF_CONFIRM_TF1 as '3m' | '5m' | '15m' | '1h') ?? '15m',
  TF_CONFIRM_TF2: (process.env.TF_CONFIRM_TF2 as '15m' | '1h' | '4h') ?? '1h',
  TF_ATR_LEN: Number(process.env.TF_ATR_LEN ?? 14),
  TF_SUPERTREND_PERIOD: Number(process.env.TF_SUPERTREND_PERIOD ?? 10),
  TF_SUPERTREND_MULT: Number(process.env.TF_SUPERTREND_MULT ?? 3),
  TF_BREAKOUT_ATR_MULT: Number(process.env.TF_BREAKOUT_ATR_MULT ?? 0.5),
  TF_VOL_FACTOR: Number(process.env.TF_VOL_FACTOR ?? 1.2),
  TF_VOL_BASIS: Number(process.env.TF_VOL_BASIS ?? 30),
  TF_ADX_MIN: Number(process.env.TF_ADX_MIN ?? 18),
  TF_MAX_EXTENSION: Number(process.env.TF_MAX_EXTENSION ?? 0.01),
  TF_LONG_MAX_RSI: Number(process.env.TF_LONG_MAX_RSI ?? 70),
  TF_SHORT_MIN_RSI: Number(process.env.TF_SHORT_MIN_RSI ?? 30),

  // Scanner / monitor
  SCAN_MONITOR_INTERVAL_MS: Number(process.env.SCAN_MONITOR_INTERVAL_MS ?? 120_000),

  // BREAK & RE-TEST
  BR_CONFIRM_TF: (process.env.BR_CONFIRM_TF as '3m' | '5m' | '15m' | '1h') ?? '15m',
  BR_LOOKBACK: Number(process.env.BR_LOOKBACK ?? 180),
  BR_EXCLUDE_RECENT: Number(process.env.BR_EXCLUDE_RECENT ?? 20),
  BR_BREAK_BUFFER: Number(process.env.BR_BREAK_BUFFER ?? 0.0015),
  BR_RETEST_TOLERANCE: Number(process.env.BR_RETEST_TOLERANCE ?? 0.001),
  BR_RETEST_DEPTH: Number(process.env.BR_RETEST_DEPTH ?? 0.0025),
  BR_MIN_ROOM: Number(process.env.BR_MIN_ROOM ?? 0.004),
  BR_VOL_FACTOR: Number(process.env.BR_VOL_FACTOR ?? 1.2),
  BR_VOL_BASIS: Number(process.env.BR_VOL_BASIS ?? 30),

  // MEAN-REVERSION SNAPBACK
  MRS_CONFIRM_TF: (process.env.MRS_CONFIRM_TF as '3m' | '5m' | '15m' | '1h') ?? '15m',
  MRS_VOL_BASIS: Number(process.env.MRS_VOL_BASIS ?? 30),
  MRS_VOL_FACTOR: Number(process.env.MRS_VOL_FACTOR ?? 1.15),
  MRS_EXT_MIN: Number(process.env.MRS_EXT_MIN ?? 0.015),
  MRS_RSI_HIGH: Number(process.env.MRS_RSI_HIGH ?? 75),
  MRS_RSI_LOW: Number(process.env.MRS_RSI_LOW ?? 25),
  MRS_STREAK_MIN: Number(process.env.MRS_STREAK_MIN ?? 3),
  MRS_ROOM_MIN: Number(process.env.MRS_ROOM_MIN ?? 0.0025),

  // MEAN REVERSION (apagado)
  MR_ADX_MAX: Number(process.env.MR_ADX_MAX ?? 20),
  MR_BB_WIDTH_MAX: Number(process.env.MR_BB_WIDTH_MAX ?? 0.025),
  MR_RSI_LOW: Number(process.env.MR_RSI_LOW ?? 32),
  MR_RSI_HIGH: Number(process.env.MR_RSI_HIGH ?? 68),
  MR_TOUCH_EPS: Number(process.env.MR_TOUCH_EPS ?? 0.001),
  MR_SPIKE_VOL_FACTOR: Number(process.env.MR_SPIKE_VOL_FACTOR ?? 2.5),
  MR_MIN_STREAK: Number(process.env.MR_MIN_STREAK ?? 2),

  MR_STRICT_SHORTS: (process.env.MR_STRICT_SHORTS ?? '1') === '1',
  MR_SHORT_CONFIRM_1H: (process.env.MR_SHORT_CONFIRM_1H ?? '0') === '1',
  MR_SHORT_1H_ADX_MIN: Number(process.env.MR_SHORT_1H_ADX_MIN ?? 18),

  ANTI_LOSS_ON: true,
  ANTI_LOSS_THR_LONG: Number(process.env.ANTI_LOSS_THR_LONG ?? 0.9),
  ANTI_LOSS_THR_SHORT: Number(process.env.ANTI_LOSS_THR_SHORT ?? 0.82),
  ALLOW_REVERSE: false,
} as const;
