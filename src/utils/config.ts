import 'dotenv/config';
import { APP_ENV, IS_TESTNET } from './runtime';

export const CONFIG = {
  APP_ENV,
  IS_TESTNET,

  // Keys (cargadas desde el .env correspondiente por DOTENV_CONFIG_PATH)
  API_KEY: process.env.BINANCE_API_KEY || '',
  API_SECRET: process.env.BINANCE_API_SECRET || '',

  // Endpoints por entorno (UM/USDT-M)
  HTTP_FUTURES: IS_TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com',
  WS_FUTURES: IS_TESTNET ? 'wss://fstream.binancefuture.com' : 'wss://fstream.binance.com',

  // Parámetros de trading (con fallbacks)
  SYMBOL: process.env.SYMBOL || 'XRPUSDT',
  LEVERAGE: Number(process.env.LEVERAGE ?? 100),
  RISK_BUFFER: 0.05,
  TP_ROE: 1.0, // 1.0 = +100% sobre el margen usado
  FEE_BUFFER_PCT: 0.001, // 0.1% extra para cubrir fees/slippage
  CHECK_INTERVAL_MS: 15_000,

  ENTRY_TIMEFRAME: '5m' as const,
  TREND_TIMEFRAME: '15m' as const,
  BREAK_LOOKBACK: 20,
  VOL_AVG_LEN: 20,
  VOL_FACTOR: 1.8,
  REQUIRE_RETEST: true,
  ATR_PERIOD: 14,
  ATR_MULT: 0.75,

  ENABLE_LOGS: true,
  ENABLE_AUTO_REBUY: true,

  // Stop Loss: nº de ticks por ENCIMA/DEBAJO de la liquidación
  SL_TICKS_ABOVE_LIQ_MAP: {
    XRPUSDT: 8, // 8 ticks * 0.0001 = 0.0008 → tu ejemplo
    BTCUSDT: 50, // ajusta a tu gusto
    ETHUSDT: 40,
  } as Record<string, number>,
  SL_TICKS_ABOVE_LIQ_DEFAULT: 8,

  // -------- STACKING / MOMENTUM --------
  STACKING_ENABLED: true,
  REENTER_ON_TP: true,
  REENTER_COOLDOWN_MS: 5_000, // espera mínima tras TP antes de re-entrar

  // Detección de rachas y volumen
  GREEN_STREAK_MIN: 3, // mín. velas verdes consecutivas para LONG
  RED_STREAK_MIN: 3, // mín. velas rojas consecutivas para SHORT
  VOL_FACTOR_ENTRY: 1.8, // volumen >= 1.5 * media -> “con volumen”
  VOL_DROP_FACTOR: 0.7, // volumen <= 0.7 * media -> “pérdida de volumen”

  // Filtros de continuidad / corte
  EMA_TRAIL_PERIOD: 20,
  EMA_TRAIL_DEV: 0.003, // 0.3% por debajo (LONG) o por encima (SHORT)
  MAX_AGAINST_STREAK_EXIT: 2, // 2 velas fuertes contra la dirección => salir
  SHARP_BODY_PCT: 0.6, // 60% del rango de la vela es cuerpo => “fuerte”
  SHARP_VOL_FACTOR: 1.7,

  BYPASS_ENTRY_CHECKS: process.env.BYPASS_ENTRY_CHECKS === '1',
  BYPASS_SIDE: process.env.BYPASS_SIDE as 'LONG' | 'SHORT' | undefined,
  CAPITAL_USAGE_PCT: 0.85,

  // Re-entrada tras TP (puedes ser igual o un poco más flexible)
  VOL_FACTOR_REENTER: 1.5,
  GREEN_STREAK_REENTER_MIN: 2,
  VOL_DROP_FACTOR_REENTER: 0.7,
  RED_STREAK_REENTER_MIN: 2,

  // Dinámica del stop
  STOP_SWING_LOOKBACK: 5,
  ATR_STOP_MULT: 1.2,
  EMA_TRAIL_DEV_STOP: 0.002, // 0.2% desde la EMA para stop
  STOP_WICK_BUFFER_TICKS: 3, // colchón anti-wicks
  STOP_MIN_IMPROVE_TICKS: 2, // no re-colocar si mejora menos de 2 ticks

  // --- Profit guard ---
  PROFIT_LOCK_BE_AT_ROE: 0.2, // al llegar a +20% ROE, activar BE (cierre a mercado si cae)
  PROFIT_GIVEBACK_ARM_ROE: 0.5, // “armar” el trailing a partir de +50% ROE
  PROFIT_GIVEBACK_DROP_REL: 0.3, // cerrar si cae ≥30% desde el pico de ROE
  PROFIT_GIVEBACK_DROP_MIN: 0.1, // pero al menos 10 pp absolutos (seguridad)
} as const;
