// src/strategies/stack.ts
import { Strategy, StrategyContext } from './types';
import { ema } from '../core/indicators/ema';
import { last, volumeAvg, countStreak } from '../core/utils/candles';
import { computeFeatures } from '../ml/features';
import { predictLong, predictShort } from '../ml/adapter';

export const StackStrategy: Strategy = {
  name: 'stack',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config, state, now } = ctx;
    const cs = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 300);
    if (cs.length < 50) return { action: 'IDLE', reason: 'few_candles' };

    const L = last(cs);
    const vavg = volumeAvg(cs, Math.max(20, config.VOL_AVG_LEN));
    const vOk = L.volume >= config.VOL_FACTOR_ENTRY * vavg;

    const gStreak = countStreak(cs, 'green');
    const rStreak = countStreak(cs, 'red');

    // (Opcional) defensa EMA-Extensión: desactívala si quieres la réplica exacta del bot viejo
    let extOk = true;
    if (typeof config.ENTRY_MAX_EMA_EXTENSION === 'number') {
      const closes = cs.map((c) => c.close);
      const e = ema(closes, config.ENTRY_EMA_PERIOD ?? 20);
      const emaNow = e[e.length - 1];
      const ext = Math.abs(L.close - emaNow) / Math.max(1e-9, emaNow);
      extOk = ext <= (config.ENTRY_MAX_EMA_EXTENSION ?? 1);
    }

    // ---- ML gate (réplica) ----
    const feats = computeFeatures(cs);
    const probLong = predictLong(feats);
    const probShort = predictShort(feats);
    const modelLongOk = probLong >= (config.ML_THRESHOLD ?? 0.65);
    const modelShortOk = probShort >= (config.ML_THRESHOLD ?? 0.65);

    // Señales “Stack” originales + ML
    const longOk = gStreak >= config.GREEN_STREAK_MIN && vOk && extOk && modelLongOk;
    const shortOk = rStreak >= config.RED_STREAK_MIN && vOk && extOk && modelShortOk;

    // --- Re-entrada tras TP (como en tu main viejo): cooldown + momentum ---
    if (
      config.REENTER_ON_TP &&
      state.mode === 'IDLE' &&
      state.lastExitReason === 'tp' &&
      typeof state.lastTPAt === 'number'
    ) {
      const since = now - state.lastTPAt;
      const cool = Number(config.REENTER_COOLDOWN_MS ?? 5000);
      if (since >= cool) {
        const vavgR = volumeAvg(cs, Math.max(20, config.VOL_AVG_LEN));
        const vOkR = last(cs).volume >= (config.VOL_FACTOR_REENTER ?? 1.5) * vavgR;
        const gR = countStreak(cs, 'green') >= (config.GREEN_STREAK_REENTER_MIN ?? 2);
        const rR = countStreak(cs, 'red') >= (config.RED_STREAK_REENTER_MIN ?? 2);

        // re-entrada respeta el mismo ML gate
        if (gR && vOkR && modelLongOk && !shortOk) {
          return { action: 'ENTER_LONG', reason: 'reenter_tp_long' };
        }
        if (rR && vOkR && modelShortOk && !longOk) {
          return { action: 'ENTER_SHORT', reason: 'reenter_tp_short' };
        }
      } else {
        return { action: 'IDLE', reason: `cooldown ${Math.round((cool - since) / 1000)}s` };
      }
    }

    // Empates: preferir la racha mayor, igual que propusiste
    if (longOk && !shortOk)
      return { action: 'ENTER_LONG', reason: `stack_long p=${probLong.toFixed(3)}` };
    if (shortOk && !longOk)
      return { action: 'ENTER_SHORT', reason: `stack_short p=${probShort.toFixed(3)}` };
    if (longOk && shortOk) {
      if (gStreak > rStreak) return { action: 'ENTER_LONG', reason: 'stack_tie→long' };
      if (rStreak > gStreak) return { action: 'ENTER_SHORT', reason: 'stack_tie→short' };
      return { action: 'IDLE', reason: 'stack_conflict' };
    }

    return {
      action: 'IDLE',
      reason: `no_stack g=${gStreak} r=${rStreak} vOk=${vOk} pL=${probLong.toFixed(2)} pS=${probShort.toFixed(2)}`,
    };
  },
};
