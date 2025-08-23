import { binanceClient } from '../api/binanceClient';
import { CONFIG } from './config';

/** -------- Helpers de filtros de símbolo -------- */
export async function getSymbolFilters(symbol: string) {
  const info = await binanceClient.futuresExchangeInfo();
  const s = info.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`Símbolo no encontrado en exchangeInfo: ${symbol}`);

  const priceFilter = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER') as any;
  const marketLot = s.filters.find((f: any) => f.filterType === 'MARKET_LOT_SIZE') as any;
  const lot = s.filters.find((f: any) => f.filterType === 'LOT_SIZE') as any;
  const minNotional =
    (s.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL') as any)?.notional ?? '5';

  const tickSize = parseFloat(priceFilter?.tickSize ?? '0.0001');
  const stepSize = parseFloat(marketLot?.stepSize ?? lot?.stepSize ?? '0.1');
  const pricePrecision = priceFilter?.tickSize?.split?.('.')[1]?.length ?? 4;
  const qtyPrecision = (marketLot?.stepSize ?? lot?.stepSize)?.split?.('.')[1]?.length ?? 1;

  return { tickSize, stepSize, pricePrecision, qtyPrecision, minNotional: parseFloat(minNotional) };
}

export function floorToStep(qty: number, step: number, precision: number) {
  const floored = Math.floor(qty / step) * step;
  return Number(floored.toFixed(precision));
}
export function ceilToStep(val: number, step: number, precision: number) {
  const ceiled = Math.ceil(val / step) * step;
  return Number(ceiled.toFixed(precision));
}
export function roundToTick(price: number, tick: number, precision: number) {
  const r = Math.round(price / tick) * tick;
  return Number(r.toFixed(precision));
}

/** ROE objetivo → precio de TP */
export function targetFromROE(
  entry: number,
  side: 'LONG' | 'SHORT',
  lev: number,
  feeBufPct: number,
) {
  const r = CONFIG.TP_ROE;
  return side === 'LONG' ? entry * (1 + r / lev + feeBufPct) : entry * (1 - r / lev - feeBufPct);
}

/** Detecta si la cuenta está en Hedge Mode */
export async function isHedgeMode(): Promise<boolean> {
  const pm = await binanceClient.futuresPositionMode();
  return !!pm.dualSidePosition;
}
