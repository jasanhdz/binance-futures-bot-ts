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

  // --- Profit guard refinements ---
  PROFIT_LOCK_BE_HYST: Number(process.env.PROFIT_LOCK_BE_HYST ?? 0.05), // ROE extra por debajo del BE para cerrar
  PROFIT_GIVEBACK_DEBOUNCE_MS: Number(process.env.PROFIT_GIVEBACK_DEBOUNCE_MS ?? 7000),
  PROFIT_GIVEBACK_ATR_ROE_MULT: Number(process.env.PROFIT_GIVEBACK_ATR_ROE_MULT ?? 0.6), // 0.6× ATR en ROE
  GIVEBACK_CONFIRM_EMA_ENABLED: (process.env.GIVEBACK_CONFIRM_EMA_ENABLED ?? '0') === '1',
  GIVEBACK_CONFIRM_EMA_PERIOD: Number(process.env.GIVEBACK_CONFIRM_EMA_PERIOD ?? 9),

  TRAIL_ATR_MULT_BASE: 3.0, // al inicio
  TRAIL_ATR_MULT_MIN: 1.2, // muy ganador → más apretado
  TRAIL_ATR_STEP_ROE: 0.5, // cada 0.5 ROE bajamos un poco

  ATR_PERIOD: 14,
  MIN_ATR_PCT: 0.0025,

  // --- IPT anti-falsos gatillos ---
  IPT_REQUIRE_RETEST: (process.env.IPT_REQUIRE_RETEST ?? '1') === '1',
  IPT_RETEST_TICKS: Number(process.env.IPT_RETEST_TICKS ?? 3), // 2–5 típico
  IPT_MAX_EMA25_EXTENSION: Number(process.env.IPT_MAX_EMA25_EXTENSION ?? 0.006), // 0.6%

  // Si el “stop lógico” (debajo/encima del pullback) queda demasiado cerca, no entrar
  MIN_STOP_DIST_TICKS: Number(process.env.MIN_STOP_DIST_TICKS ?? 4),
  MIN_STOP_DIST_PCT: Number(process.env.MIN_STOP_DIST_PCT ?? 0.0015), // 0.15% del precio

  // ---------- Router (detección de régimen) ----------
  ROUTER_TREND_SCORE_STRONG: Number(process.env.ROUTER_TREND_SCORE_STRONG ?? 2), // |score|≥2 → tendencia
  ROUTER_TREND_SCORE_WEAK: Number(process.env.ROUTER_TREND_SCORE_WEAK ?? 1), // |score|≤1 → débil/neutral
  ROUTER_ATR_MIN_TREND: Number(process.env.ROUTER_ATR_MIN_TREND ?? 0.0025), // ≥0.25% para usar IPT
  ROUTER_EMA_SLOPE_LOOKBACK: Number(process.env.ROUTER_EMA_SLOPE_LOOKBACK ?? 8),
  ROUTER_EMA_SLOPE_FLAT_MAX: Number(process.env.ROUTER_EMA_SLOPE_FLAT_MAX ?? 0.0006), // 0.06% en 8 velas

  // ---------- Parámetros IPT (ya los tienes) ----------
  // IPT_MAX_EMA25_EXTENSION, IPT_REQUIRE_RETEST, IPT_RETEST_TICKS, MIN_STOP_DIST_*, etc.

  // ---------- Parámetros Range-Reversion (ya propuestos) ----------
  RR_BAND_K: Number(process.env.RR_BAND_K ?? 1.6),
  RR_MIN_ATR_PCT: Number(process.env.RR_MIN_ATR_PCT ?? 0.001),
  RR_MAX_ATR_PCT: Number(process.env.RR_MAX_ATR_PCT ?? 0.006),
  RR_MAX_EMA_SLOPE: Number(process.env.RR_MAX_EMA_SLOPE ?? 0), // no usado en router si usas ROUTER_EMA_SLOPE_FLAT_MAX
  RR_MIN_BODY_PCT: Number(process.env.RR_MIN_BODY_PCT ?? 0.3),
  RR_MAX_WICKINESS: Number(process.env.RR_MAX_WICKINESS ?? 0.6),
};
