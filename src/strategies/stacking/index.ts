// src/strategies/stacking/index.ts
import { Strategy, StrategyContext } from '../types';
import { ema } from '../../core/indicators/ema';
import { last, avg, bodyPct, countStreak } from '../../core/utils/candles';

export const StackingStrategy: Strategy = {
  name: 'stacking',
  timeframe: '5m',
  async evaluate({ symbol, exchange, config, state, now }: StrategyContext) {
    // Solo generamos señal de entrada cuando estamos IDLE
    if (state.mode !== 'IDLE') return { action: 'IDLE' };

    // 0) Cooldown de re-entrada tras TP (evita “chasing” inmediato)
    const REENTER_COOLDOWN_MS = Number((config as any).REENTER_COOLDOWN_MS ?? 60_000);
    if (
      state.lastExitReason === 'tp' &&
      typeof state.lastTPAt === 'number' &&
      now - state.lastTPAt < REENTER_COOLDOWN_MS
    ) {
      return { action: 'IDLE', reason: 'tp_cooldown' };
    }

    // 1) Datos del timeframe de entrada
    const candles = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (candles.length < 60) return { action: 'IDLE', reason: 'few_candles' };

    const c0 = last(candles);
    const c1 = candles[candles.length - 2];
    const closes = candles.map((c) => c.close);

    const vavg = avg(candles.slice(-Math.max(20, config.VOL_AVG_LEN) - 1, -1).map((c) => c.volume));
    const bodyPct0 = bodyPct(c0);

    const emaEntry = last(ema(closes, config.ENTRY_EMA_PERIOD));

    // 2) Filtros: clímax y sobre-extensión (no perseguir precio)
    const climax =
      bodyPct0 >= config.CLIMAX_BODY_PCT && c0.volume >= config.CLIMAX_VOL_FACTOR * vavg;

    const distUp = (c0.close - emaEntry) / Math.max(1e-9, emaEntry); // LONG: no demasiado arriba
    const distDn = (emaEntry - c0.close) / Math.max(1e-9, emaEntry); // SHORT: no demasiado abajo

    // 3) Tendencia mayor (alineación con EMA del TF superior)
    const trend = await exchange.getCandles(symbol, config.TREND_TIMEFRAME, 300);
    if (trend.length < config.TREND_EMA_PERIOD + 2) {
      return { action: 'IDLE', reason: 'few_trend_candles' };
    }
    const eTrend = ema(
      trend.map((c) => c.close),
      config.TREND_EMA_PERIOD,
    );
    const eLast = eTrend[eTrend.length - 1];
    const ePrev = eTrend[eTrend.length - 2];
    const trendUp = eLast > ePrev;
    const trendDown = eLast < ePrev;

    // 4) Rachas y anti-exhaustión
    const greens = countStreak(candles, 'green');
    const reds = countStreak(candles, 'red');
    const ENTRY_MAX_STREAK = Number((config as any).ENTRY_MAX_STREAK ?? 6); // evita comprar el último empujón

    // 5) Break & Retest simple (muy recomendado)
    // Se mira un HH/LL previo (excluyendo la vela actual) y se exige pullback hacia EMA/zona
    const RETEST_LOOKBACK = Number((config as any).RETEST_LOOKBACK ?? 30);
    const prevSlice = candles.slice(-RETEST_LOOKBACK - 1, -1);
    const prevHigh = Math.max(...prevSlice.map((c) => c.high));
    const prevLow = Math.min(...prevSlice.map((c) => c.low));
    const brokeUpPrev = c1.close > prevHigh || c1.high > prevHigh;
    const brokeDnPrev = c1.close < prevLow || c1.low < prevLow;

    // Retest: la vela actual vuelve a tocar zona EMA o el nivel roto
    const longRetest = c0.low <= Math.max(emaEntry, prevHigh);
    const shortRetest = c0.high >= Math.min(emaEntry, prevLow);

    // 6) Reglas de entrada (preferimos break&retest; si no, stacking clásico)
    // LONG
    if (!climax && trendUp && distUp <= config.ENTRY_MAX_EMA_EXTENSION) {
      // Break & Retest LONG
      if (brokeUpPrev && longRetest && c0.volume >= config.VOL_FACTOR_ENTRY * vavg) {
        return { action: 'ENTER_LONG', reason: 'break_retest_long' };
      }
      // Stacking LONG con anti-exhaustión
      if (
        greens >= config.GREEN_STREAK_MIN &&
        greens <= ENTRY_MAX_STREAK &&
        c0.volume >= config.VOL_FACTOR_ENTRY * vavg
      ) {
        return { action: 'ENTER_LONG', reason: 'stack_long' };
      }
    }

    // SHORT
    if (!climax && trendDown && distDn <= config.ENTRY_MAX_EMA_EXTENSION) {
      // Break & Retest SHORT
      if (brokeDnPrev && shortRetest && c0.volume >= config.VOL_FACTOR_ENTRY * vavg) {
        return { action: 'ENTER_SHORT', reason: 'break_retest_short' };
      }
      // Stacking SHORT con anti-exhaustión
      if (
        reds >= config.RED_STREAK_MIN &&
        reds <= ENTRY_MAX_STREAK &&
        c0.volume >= config.VOL_FACTOR_ENTRY * vavg
      ) {
        return { action: 'ENTER_SHORT', reason: 'stack_short' };
      }
    }

    return { action: 'IDLE', reason: 'no_setup' };
  },
};
