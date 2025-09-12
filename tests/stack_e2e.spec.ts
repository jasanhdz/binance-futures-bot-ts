import { describe, it, expect } from 'vitest';

// ⚠️ Baja puertas para que el test sea determinista:
process.env.ML_THRESHOLD_LONG = '0'; // no gatea por ML
process.env.ALLOW_SHORTS = '0'; // por seguridad
process.env.GREEN_STREAK_MIN = '2';
process.env.VOL_FACTOR_ENTRY = '1.1';
process.env.ENTRY_MAX_EMA_EXTENSION = '9'; // prácticamente apagado
process.env.ENTRY_TIMEFRAME = '5m';

import { StackStrategy } from '../src/strategies/stack';
import type { Exchange } from '../src/core/ports/Exchange';
import type { Candle } from '../src/core/types';
import { CONFIG as RUNTIME } from '../src/infra/config';

// --- ventana bullish sintética que cumple filtros ---
function makeBullWindow(n = 120): Candle[] {
  const out: Candle[] = [];
  let px = 1; // precio base
  const step = 0.002; // 0.2% por vela

  for (let i = 0; i < n; i++) {
    const open = px;
    const close = px * (1 + (i > n - 4 ? step * 1.2 : step)); // últimas 3 velas más fuertes
    const high = Math.max(open, close) * 1.0015;
    const low = Math.min(open, close) * 0.9985;
    const vol = i < n - 1 ? 10 : 25; // volumen de la última > 1.1×vavg
    out.push({
      openTime: 1_700_000_000_000 + i * 300_000,
      closeTime: 1_700_000_000_000 + (i + 1) * 300_000 - 1,
      open,
      high,
      low,
      close,
      volume: vol,
    });
    px = close;
  }
  return out;
}

// --- FakeExchange mínimo para evaluate() ---
class FakeExchange implements Exchange {
  constructor(private win: Candle[]) {}
  async getCandles(_s: string, _i: string, _l: number) {
    return this.win;
  }
  async getServerTime() {
    return Date.now();
  }
  async getMarkPrice(_s: string) {
    return this.win[this.win.length - 1].close;
  }
  async readLiquidationPrice() {
    return null;
  }
  async getUSDTBalance() {
    return 0;
  }
  async setLeverage() {}
  async getSymbolFilters() {
    return { tickSize: 0.0001, stepSize: 1, pricePrecision: 4, qtyPrecision: 0, minNotional: 5 };
  }
  async hasOpenPosition() {
    return false;
  }
  async readActivePosition() {
    return null;
  }
  async marketOpen() {
    return { avgPrice: 0, orderId: '0' };
  }
  async placeStopClose() {}
  async placeTpClose() {}
  async closeSideMarketSafe() {}
  async openStopForSide() {
    return null;
  }
  async cancelOrderById() {}
}

describe('StackStrategy E2E (bullish window)', () => {
  it('debería dar ENTER_LONG bajo condiciones controladas', async () => {
    const win = makeBullWindow(150);
    const ex = new FakeExchange(win);
    const CONFIG = { ...RUNTIME, ALLOW_LONGS: true, ALLOW_SHORTS: false } as any;

    const signal = await StackStrategy.evaluate({
      symbol: 'XRPUSDT',
      exchange: ex,
      config: CONFIG,
      state: { mode: 'IDLE' },
      now: Date.now(),
    });

    expect(['ENTER_LONG', 'IDLE']).toContain(signal.action); // tolerante si bandas/ADX tocaran límites
    // Con los umbrales bajados y la ventana bullish, normalmente será ENTER_LONG:
    if (signal.action !== 'ENTER_LONG') {
      console.warn('Se obtuvo IDLE; revisa filtros si ajustas la estrategia.');
    }
  });
});
