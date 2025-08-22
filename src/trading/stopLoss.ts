// src/trading/stopLoss.ts
import { CONFIG } from '../utils/config';

export function roundToTick(price: number, tick: number, precision: number) {
  const rounded = Math.round(price / tick) * tick;
  return Number(rounded.toFixed(precision));
}

/**
 * Calcula un stop a N ticks de la liquidación y aplica guardas para no
 * colocarlo del lado equivocado (que se ejecute al instante).
 */
export function computeStopFromLiqTicks(params: {
  side: 'LONG' | 'SHORT';
  liqPrice: number;
  currentPrice: number;
  entryPrice: number;
  tickSize: number;
  pricePrecision: number;
  symbol: string;
}) {
  const { side, liqPrice, currentPrice, entryPrice, tickSize, pricePrecision, symbol } = params;

  const ticks = CONFIG.SL_TICKS_ABOVE_LIQ_MAP[symbol] ?? CONFIG.SL_TICKS_ABOVE_LIQ_DEFAULT;

  // Base: mover desde la liq N ticks en la dirección correcta
  let raw =
    side === 'LONG'
      ? liqPrice + ticks * tickSize // por ENCIMA de liq (pero por debajo del precio actual)
      : liqPrice - ticks * tickSize; // por DEBAJO de liq (pero por encima del precio actual)

  // Guardas de seguridad
  if (side === 'LONG') {
    // Debe quedar por debajo del precio actual (si no, se ejecuta ya)
    raw = Math.min(raw, currentPrice - tickSize);
    // Y por encima de la liquidación
    raw = Math.max(raw, liqPrice + tickSize * 0.5);
    // Y normalmente por debajo de la entrada
    raw = Math.min(raw, entryPrice - tickSize);
  } else {
    // SHORT: debe quedar por encima del precio actual (si no, se ejecuta ya)
    raw = Math.max(raw, currentPrice + tickSize);
    // Y por debajo de la liquidación
    raw = Math.min(raw, liqPrice - tickSize * 0.5);
    // Y normalmente por encima de la entrada
    raw = Math.max(raw, entryPrice + tickSize);
  }

  return roundToTick(raw, tickSize, pricePrecision);
}
