// src/core/risk/sizing.ts
import * as fs from 'fs';
import * as path from 'path';
import { SymbolFilters } from '../ports/Exchange';

// Cache simple para no leer disco en cada tick (dura 1 hora)
const METADATA_CACHE: Record<string, { acc: number; ts: number }> = {};
const METADATA_TTL = 60 * 60 * 1000;
// Ajusta la ruta relativa según la estructura de tu proyecto
const MODELS_DIR = path.resolve(__dirname, '../../../../models/v2_ensemble');

function getModelAccuracy(symbol: string): number {
  const now = Date.now();
  if (METADATA_CACHE[symbol] && now - METADATA_CACHE[symbol].ts < METADATA_TTL) {
    return METADATA_CACHE[symbol].acc;
  }

  try {
    const metaPath = path.join(MODELS_DIR, symbol, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      const raw = fs.readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(raw);
      const acc = meta.accuracy || 0;
      METADATA_CACHE[symbol] = { acc, ts: now };
      return acc;
    }
  } catch (e) {
    // Si no hay metadata, asumimos 0 (neutral)
  }
  return 0;
}

export function floorToStep(val: number, step: number, precision: number): number {
  const f = Math.pow(10, precision);
  const v = Math.floor(val / step) * step;
  return Math.floor(v * f) / f;
}

export function ceilToStep(val: number, step: number, precision: number): number {
  const f = Math.pow(10, precision);
  const v = Math.ceil(val / step) * step;
  return Math.ceil(v * f) / f;
}

export type SizingParams = {
  usdtBalance: number;
  reserve: number;
  capitalPct: number; // Allocation base (0.75)
  price: number;
  leverage: number;
  feePct: number;
  filters: SymbolFilters;
  symbol?: string; // Requerido para buscar accuracy
};

export type SizingResult =
  | { qty: number; diagnostics: Record<string, unknown> }
  | { reason: string; debug?: Record<string, unknown> };

export function sizeByBudget(params: SizingParams): SizingResult {
  const { usdtBalance, reserve, capitalPct, price, leverage, feePct, filters, symbol } = params;

  const effectiveBalance = Math.max(0, usdtBalance - reserve);
  if (effectiveBalance <= 0) {
    return { reason: 'insufficient_wallet_after_reserve', debug: { usdtBalance, reserve } };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 🎯 SMART SIZING (Meritocracia)
  // Estrategia: Penalizar a los débiles para reservar liquidez a los fuertes.
  // ═══════════════════════════════════════════════════════════════════════
  let accuracyMultiplier = 1.0;
  let accuracy = 0;

  if (symbol) {
    accuracy = getModelAccuracy(symbol);

    if (accuracy > 0.80) {
      // 🚀 ELITE (BNB > 80%): +20% capital
      // 0.75 * 1.2 = 0.90 (Usa casi todo el disponible)
      accuracyMultiplier = 1.2;
    } else if (accuracy > 0.65) {
      // 🔥 HIGH (SOL > 65%): +10% capital
      // 0.75 * 1.1 = 0.825
      accuracyMultiplier = 1.1;
    } else if (accuracy > 0.60) {
      // ✅ GOOD (BTC > 60%): Base
      // 0.75 * 1.0 = 0.75
      accuracyMultiplier = 1.0;
    } else if (accuracy < 0.60 && accuracy > 0) {
      // ⚠️ MEDIOCRE (< 60%): -40% capital
      // 0.75 * 0.6 = 0.45 (Deja el 55% libre para un trade mejor)
      accuracyMultiplier = 0.6;
    }
  }

  // Calcular porcentaje final
  let adjustedCapitalPct = capitalPct * accuracyMultiplier;

  // 🛡️ CLAMP: Nunca superar el 98% del balance disponible
  adjustedCapitalPct = Math.min(adjustedCapitalPct, 0.98);

  // Presupuesto Final
  let budget = effectiveBalance * adjustedCapitalPct;

  // Cálculo estándar de posición
  const rawNotional = budget * Math.max(1, leverage);
  let rawQty = rawNotional / price;

  // Buffer de Fees
  rawQty = rawQty * (1 - feePct);

  // Redondeo
  let qty = floorToStep(rawQty, filters.stepSize, filters.qtyPrecision);

  // Validaciones de Notional
  const notional = qty * price;
  if (notional < filters.minNotional) {
    const minQty = ceilToStep(filters.minNotional / price, filters.stepSize, filters.qtyPrecision);
    const costForMin = (minQty * price) / leverage;

    if (costForMin < effectiveBalance) {
      qty = minQty;
    } else {
      return {
        reason: 'min_notional_insufficient_funds',
        debug: { notional, minNotional: filters.minNotional, costForMin, effectiveBalance },
      };
    }
  }

  if (filters.notionalCap && qty * price > filters.notionalCap) {
    qty = floorToStep(filters.notionalCap / price, filters.stepSize, filters.qtyPrecision);
  }

  const initMargin = (qty * price) / leverage;

  return {
    qty,
    diagnostics: {
      initMargin,
      fees: qty * price * feePct,
      leverage,
      accuracy,
      accMult: accuracyMultiplier,
      adjustedPct: adjustedCapitalPct,
      finalNotional: qty * price
    },
  };
}
