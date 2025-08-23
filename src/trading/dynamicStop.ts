// Stop dinámico por estructura + ATR + EMA, con colchón anti-wicks.
import { binanceClient } from '../api/binanceClient';
import { getCandles, ema, avg } from '../strategy/indicators';
import { CONFIG } from '../utils/config';

type Side = 'LONG' | 'SHORT';

function last<T>(a: T[]) {
  return a[a.length - 1];
}
function roundToTick(v: number, tick: number, precision: number) {
  const r = Math.round(v / tick) * tick;
  return Number(r.toFixed(precision));
}
function lookbackLow(values: number[], n: number) {
  return Math.min(...values.slice(-n - 1, -1));
}
function lookbackHigh(values: number[], n: number) {
  return Math.max(...values.slice(-n - 1, -1));
}

async function getSymbolFilters(symbol: string) {
  const info = await binanceClient.futuresExchangeInfo();
  const s = info.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`Símbolo no encontrado: ${symbol}`);
  const pf = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER') as any;
  const tickSize = parseFloat(pf?.tickSize ?? '0.0001');
  const pricePrecision = pf?.tickSize?.split?.('.')[1]?.length ?? 4;
  return { tickSize, pricePrecision };
}

/** Calcula el mejor stop candidato (el más cercano *válido* a precio) */
export async function calcDynamicStop(symbol: string, side: Side) {
  const tf = CONFIG.ENTRY_TIMEFRAME;
  const candles = await getCandles(symbol, tf, 200);
  if (candles.length < 50) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  // EMA trail
  const emaTrail = last(ema(closes, CONFIG.EMA_TRAIL_PERIOD));
  // ATR simple (media de ranges)
  const ranges = candles.slice(1).map((c, i) => {
    const p = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  });
  const atr = avg(ranges.slice(-CONFIG.ATR_PERIOD));

  const { tickSize, pricePrecision } = await getSymbolFilters(symbol);

  // Swing reciente
  const SWING_N = CONFIG.STOP_SWING_LOOKBACK ?? 5;
  const swingLow = lookbackLow(lows, SWING_N);
  const swingHigh = lookbackHigh(highs, SWING_N);

  // Candidatos con padding:
  const wickTicks = CONFIG.STOP_WICK_BUFFER_TICKS ?? 3;
  const emaDev = CONFIG.EMA_TRAIL_DEV_STOP ?? 0.002; // 0.2%
  const atrMult = CONFIG.ATR_STOP_MULT ?? 1.2;

  let candidates: number[] = [];
  if (side === 'LONG') {
    candidates = [
      swingLow - atrMult * atr, // debajo del último swing (con colchón ATR)
      emaTrail * (1 - emaDev), // por debajo de la EMA
    ];
    // Escoge el más alto (más ceñido pero válido para LONG)
    let raw = Math.max(...candidates);
    // Colchón de ticks
    raw -= wickTicks * tickSize;
    return roundToTick(raw, tickSize, pricePrecision);
  } else {
    candidates = [
      swingHigh + atrMult * atr, // encima del swing (colchón ATR)
      emaTrail * (1 + emaDev), // por encima de la EMA
    ];
    // Escoge el más bajo (más ceñido pero válido para SHORT)
    let raw = Math.min(...candidates);
    raw += wickTicks * tickSize;
    return roundToTick(raw, tickSize, pricePrecision);
  }
}

/** Crea/actualiza el STOP_MARKET reduceOnly closePosition=true, solo si mejora. */
export async function upsertCloseStop(symbol: string, side: Side, newStop: number) {
  const { tickSize, pricePrecision } = await getSymbolFilters(symbol);
  const IMPROVE_TICKS = CONFIG.STOP_MIN_IMPROVE_TICKS ?? 2;

  // Busca stop actual (reduceOnly closePosition) en órdenes abiertas
  const open = await binanceClient.futuresOpenOrders({ symbol });
  const wantOrderSide = side === 'LONG' ? 'SELL' : 'BUY';
  const current = open.find(
    (o) => o.type === 'STOP_MARKET' && o.side === wantOrderSide && o.closePosition === true,
  );

  const newRounded = roundToTick(newStop, tickSize, pricePrecision);

  if (!current) {
    // No hay stop → crear
    await binanceClient.futuresOrder({
      symbol,
      side: wantOrderSide,
      type: 'STOP_MARKET',
      stopPrice: String(newRounded),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    });
    return { action: 'created', stop: newRounded };
  }

  const old = parseFloat(current.stopPrice!);
  const improveBy = Math.abs(newRounded - old) / tickSize;

  // Regla "apretar solo si mejora":
  const isBetter =
    (side === 'LONG' && newRounded > old + IMPROVE_TICKS * tickSize) ||
    (side === 'SHORT' && newRounded < old - IMPROVE_TICKS * tickSize);

  if (!isBetter) return { action: 'kept', stop: old };

  // Cancelar y re-crear (Binance no permite modificar precio de STOP_MARKET)
  await binanceClient.futuresCancelOrder({ symbol, orderId: Number(current.orderId) });
  await binanceClient.futuresOrder({
    symbol,
    side: wantOrderSide,
    type: 'STOP_MARKET',
    stopPrice: String(newRounded),
    closePosition: 'true',
    workingType: 'MARK_PRICE',
  });
  return { action: 'updated', from: old, to: newRounded };
}
