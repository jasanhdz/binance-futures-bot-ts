// src/infra/config.ts
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

  // --- Mercado / sizing ---
  SYMBOL: process.env.SYMBOL || 'XRPUSDT',
  LEVERAGE: Number(process.env.LEVERAGE ?? 100),
  CAPITAL_USAGE_PCT: Number(process.env.CAPITAL_USAGE_PCT ?? 0.85),
  MIN_WALLET_RESERVE_USDT: Number(process.env.MIN_WALLET_RESERVE_USDT ?? 0.1),
  FEE_BUFFER_PCT: Number(process.env.FEE_BUFFER_PCT ?? 0.001),

  // --- Take-profit por ROE ---
  TP_ROE: Number(process.env.TP_ROE ?? 1.0),

  // --- Timeframes / volumen para señales ---
  ENTRY_TIMEFRAME: (process.env.ENTRY_TIMEFRAME as '1m' | '5m' | '15m' | '1h') || '5m',
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

  // --- Stops iniciales ---
  SL_TICKS_ABOVE_LIQ_MAP: {
    XRPUSDT: 69,
    ETHUSDT: 8,
    BTCUSDT: 50,
  } as Record<string, number>,
  SL_TICKS_ABOVE_LIQ_DEFAULT: Number(process.env.SL_TICKS_ABOVE_LIQ_DEFAULT ?? 69),

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
  MAX_RISK_PCT: 0,

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

  ALLOW_LONGS: true,
  ALLOW_SHORTS: true, // ⟵ apaga shorts por ahora

  // Umbrales ML por lado (asimétricos)
  ML_THRESHOLD_LONG: Number(process.env.ML_THRESHOLD_LONG ?? 0.6),
  ML_THRESHOLD_SHORT: Number(process.env.ML_THRESHOLD_SHORT ?? 0.8),

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
