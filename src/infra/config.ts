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
  MIN_WALLET_RESERVE_USDT: Number(process.env.MIN_WALLET_RESERVE_USDT ?? 0.5),
  FEE_BUFFER_PCT: Number(process.env.FEE_BUFFER_PCT ?? 0.001),

  // --- Take-profit por ROE ---
  TP_ROE: Number(process.env.TP_ROE ?? 1.0),

  // --- Timeframes / volumen para señales ---
  ENTRY_TIMEFRAME: (process.env.ENTRY_TIMEFRAME as '1m' | '5m' | '15m' | '1h') || '5m',
  VOL_AVG_LEN: Number(process.env.VOL_AVG_LEN ?? 20),
  VOL_FACTOR_ENTRY: Number(process.env.VOL_FACTOR_ENTRY ?? 1.8),

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
    XRPUSDT: 8,
    ETHUSDT: 8,
    BTCUSDT: 50,
  } as Record<string, number>,
  SL_TICKS_ABOVE_LIQ_DEFAULT: Number(process.env.SL_TICKS_ABOVE_LIQ_DEFAULT ?? 8),

  // --- Guards de beneficio / seguridad ---
  PROFIT_LOCK_BE_AT_ROE: Number(process.env.PROFIT_LOCK_BE_AT_ROE ?? 0.2),
  PROFIT_GIVEBACK_ARM_ROE: Number(process.env.PROFIT_GIVEBACK_ARM_ROE ?? 0.5),
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
  MAX_RISK_PCT: 0.008,

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
  ALLOW_SHORTS: false, // ⟵ apaga shorts por ahora

  // Umbrales ML por lado (asimétricos)
  ML_THRESHOLD_LONG: Number(process.env.ML_THRESHOLD_LONG ?? 0.6),
  ML_THRESHOLD_SHORT: Number(process.env.ML_THRESHOLD_SHORT ?? 0.8),

  // Filtros de tendencia para permitir short
  ADX_MIN_FOR_SHORT: Number(process.env.ADX_MIN_FOR_SHORT ?? 25),
  REQUIRE_BEAR_MA_FOR_SHORT: (process.env.REQUIRE_BEAR_MA_FOR_SHORT ?? '1') === '1',
} as const;
