export const CONFIG = {
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
  SYMBOL: process.env.SYMBOL || 'XRPUSDT',
  LEVERAGE: Number(process.env.LEVERAGE ?? 100),
  CAPITAL_USAGE_PCT: 0.85,
  FEE_BUFFER_PCT: 0.001,
  TP_ROE: 1.0,
  MIN_WALLET_RESERVE_USDT: 0.5,
  ENTRY_TIMEFRAME: '5m',
  TREND_TIMEFRAME: '15m',
  VOL_AVG_LEN: 20,
  GREEN_STREAK_MIN: 3,
  RED_STREAK_MIN: 3,
  ENTRY_EMA_PERIOD: 20,
  ENTRY_MAX_EMA_EXTENSION: 0.004,
  CLIMAX_BODY_PCT: 0.75,
  CLIMAX_VOL_FACTOR: 2.2,
  TREND_EMA_PERIOD: 50,
  SL_TICKS_ABOVE_LIQ_MAP: { XRPUSDT: 8 } as Record<string, number>,
  SL_TICKS_ABOVE_LIQ_DEFAULT: 8,
  PROFIT_LOCK_BE_AT_ROE: 0.2,
  PROFIT_GIVEBACK_ARM_ROE: 0.5,
  PROFIT_GIVEBACK_DROP_REL: 0.3,
  PROFIT_GIVEBACK_DROP_MIN: 0.1,
  VOL_FACTOR_ENTRY: 1.8,

  REENTER_COOLDOWN_MS: Number(process.env.REENTER_COOLDOWN_MS ?? 60_000),

  EARLY_FAIL_WINDOW_MS: Number(process.env.EARLY_FAIL_WINDOW_MS ?? 12 * 60_000),
  EARLY_FAIL_VOL_FACTOR: Number(process.env.EARLY_FAIL_VOL_FACTOR ?? 1.5),
  SHARP_BODY_PCT: Number(process.env.SHARP_BODY_PCT ?? 0.6),

  ENTRY_MAX_STREAK: Number(process.env.ENTRY_MAX_STREAK ?? 6),
  RETEST_LOOKBACK: Number(process.env.RETEST_LOOKBACK ?? 30),

  PYRAMID_MAX_UNITS: 3, // nº de “adds” máximos (además de la entrada inicial)
  PYRAMID_STEP_ATR: 0.5, // cada cuánto ATR se permite un add
  PYRAMID_UNIT_PCT_OF_ENTRY: 0.5, // el add será 50% del tamaño inicial (ejemplo)
  ATR_LEN: 14, // ATR para pasos y trailing
  TRAIL_ATR_MULT: 2.5,
};
