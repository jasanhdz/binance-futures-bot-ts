// src/core/risk/sizing.ts
import { SymbolFilters } from '../ports/Exchange';

/** Redondea hacia abajo respetando el step/precisión del símbolo. */
export function floorToStep(x: number, step: number, prec: number) {
  const v = Math.floor(x / step) * step;
  return Number(v.toFixed(prec));
}

/** Redondea hacia arriba respetando el step/precisión del símbolo. */
export function ceilToStep(x: number, step: number, prec: number) {
  const v = Math.ceil(x / step) * step;
  return Number(v.toFixed(prec));
}

/**
 * Calcula la cantidad (qty) a abrir en función de:
 * - Balance USDT y reserva mínima
 * - % de capital a usar
 * - Precio actual y apalancamiento
 * - Colchón de fees (feePct)
 * - Filtros del símbolo (minNotional, stepSize, notionalCap por leverage, etc.)
 *
 * Devuelve { qty } cuando es viable, o { qty: 0, reason } cuando no.
 * Incluye `diagnostics` para trazabilidad cuando es viable.
 */
export function sizeByBudget(params: {
  usdtBalance: number;
  reserve: number;
  capitalPct: number;
  price: number;
  leverage: number;
  feePct: number;
  filters: SymbolFilters;
}):
  | { qty: number; diagnostics: Record<string, number | string | boolean> }
  | {
      qty: 0;
      reason: 'budget_insufficient' | 'margin_unfit' | 'risk_cap_below_min';
      debug?: Record<string, number | string | boolean>;
    } {
  const { usdtBalance, reserve, capitalPct, price, leverage, feePct, filters } = params;

  // Guardas básicas
  if (!Number.isFinite(price) || price <= 0) {
    return { qty: 0, reason: 'margin_unfit' };
  }

  const { stepSize, qtyPrecision, minNotional, notionalCap } = filters;

  // 1) Presupuesto disponible tras reserva
  const budget = Math.max(0, (usdtBalance - reserve) * capitalPct);
  if (budget <= 0) return { qty: 0, reason: 'budget_insufficient' };

  // 2) Propuesta de qty por presupuesto y leverage
  const qtyInitial = (budget * leverage) / price;
  let qty = floorToStep(qtyInitial, stepSize, qtyPrecision);

  // 3) Cumplir mínimo nocional del símbolo
  const minQtyByNotional = ceilToStep(minNotional / price, stepSize, qtyPrecision);
  if (qty < minQtyByNotional) qty = minQtyByNotional;

  // 4) Ajuste por margen disponible (initMargin + fees <= usdtBalance - reserve)
  const maxSpendable = Math.max(0, usdtBalance - reserve);
  const fits = (q: number) => {
    const notional = q * price;
    const fees = notional * feePct; // estimación
    const initMargin = notional / leverage;
    return initMargin + fees <= maxSpendable;
  };

  let marginIterations = 0;
  while (!fits(qty) && qty > 0 && marginIterations++ < 200) {
    qty = floorToStep(qty - stepSize, stepSize, qtyPrecision);
  }
  if (qty <= 0) return { qty: 0, reason: 'margin_unfit' };

  // 5) Límite por risk-bracket (notionalCap) para el leverage actual
  let reducedByCap = false;
  if (Number.isFinite(notionalCap!)) {
    // Pequeño margen de seguridad para no rebasar por redondeos
    const safeCap = (notionalCap as number) * 0.98;
    const maxQtyByCap = floorToStep(safeCap / price, stepSize, qtyPrecision);
    if (qty > maxQtyByCap) {
      qty = maxQtyByCap;
      reducedByCap = true;
    }
    // Si el cap queda por debajo del mínimo nocional exigido por el símbolo → no se puede abrir
  if (qty < minQtyByNotional) {
    return {
      qty: 0,
      reason: 'risk_cap_below_min',
      debug: {
        minQtyByNotional,
        maxQtyByCap,
        price,
        stepSize,
        minNotional,
        notionalCap: safeCap,
      },
    };
  }
  }

  // 6) Diagnósticos para logging/telemetría
  const notional = qty * price;
  const fees = notional * feePct;
  const initMargin = notional / leverage;

  return {
    qty,
    diagnostics: {
      budget,
      qtyInitial: Number(qtyInitial.toFixed(qtyPrecision)),
      minQtyByNotional,
      maxSpendable,
      notional: Number(notional.toFixed(6)),
      initMargin: Number(initMargin.toFixed(6)),
      fees: Number(fees.toFixed(6)),
      leverage,
      price,
      reducedByCap,
      notionalCap: Number.isFinite(notionalCap!) ? Number((notionalCap as number).toFixed(6)) : -1,
      marginIterations,
      stepSize,
    },
  };
}
