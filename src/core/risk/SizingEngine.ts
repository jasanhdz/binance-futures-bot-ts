export interface QuantityFilters {
  stepSize: number;
  qtyPrecision: number;
  minNotional: number;
  maxNotional?: number;
  minQty?: number;
  maxQty?: number;
}

export interface MarginBudgetSizingInput extends QuantityFilters {
  /** Already allocated USDT margin, after the caller's existing capital haircut. */
  marginBudget: number;
  entryPrice: number;
  leverage: number;
  /** Optional retry ceiling; never increases an earlier approved quantity. */
  maxQuantity?: number;
  /** Explicit USDT loss budget; positionFraction is NOT a loss fraction. */
  lossBudget?: number;
  /** Stop distance plus explicitly supplied per-unit costs, not a capital haircut. */
  riskPerUnit?: number;
}

export interface MarginBudgetSizingResult {
  valid: boolean;
  reason?: string;
  quantity: number;
  notional: number;
  marginRequired: number;
  maxLoss?: number;
}

/** Invalid/incompatible filters return NaN, never a fabricated executable zero. */
export function roundQuantityDown(
  quantity: number,
  filters: Pick<QuantityFilters, 'stepSize' | 'qtyPrecision'>,
): number {
  const { stepSize, qtyPrecision } = filters;
  if (
    !Number.isFinite(quantity) ||
    quantity < 0 ||
    !Number.isFinite(stepSize) ||
    stepSize <= 0 ||
    !Number.isInteger(qtyPrecision) ||
    qtyPrecision < 0 ||
    qtyPrecision > 15
  )
    return NaN;
  const scale = 10 ** qtyPrecision;
  const scaledStep = stepSize * scale;
  const step = Math.round(scaledStep);
  if (
    !Number.isSafeInteger(step) ||
    step <= 0 ||
    Math.abs(scaledStep - step) > Number.EPSILON * Math.abs(scaledStep) * 4
  )
    return NaN;
  const units = Math.floor(quantity * scale);
  if (!Number.isSafeInteger(units)) return NaN;
  let stepped = Math.floor(units / step) * step;
  if (stepped / scale > quantity) stepped -= step;
  return stepped / scale;
}

export function calculateMarginBudgetSizing(
  input: MarginBudgetSizingInput,
): MarginBudgetSizingResult {
  const fail = (reason: string): MarginBudgetSizingResult => ({
    valid: false,
    reason,
    quantity: 0,
    notional: 0,
    marginRequired: 0,
  });
  if (!Number.isFinite(input.marginBudget) || input.marginBudget <= 0)
    return fail('INVALID_MARGIN_BUDGET');
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0)
    return fail('INVALID_ENTRY_PRICE');
  if (!Number.isFinite(input.leverage) || input.leverage <= 0) return fail('INVALID_LEVERAGE');
  if (!Number.isFinite(input.minNotional) || input.minNotional < 0)
    return fail('INVALID_MIN_NOTIONAL');
  for (const value of [
    input.maxNotional,
    input.maxQty,
    input.maxQuantity,
    input.lossBudget,
    input.riskPerUnit,
  ]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0))
      return fail('INVALID_SIZING_CAP');
  }
  if (input.minQty !== undefined && (!Number.isFinite(input.minQty) || input.minQty < 0))
    return fail('INVALID_MIN_QUANTITY');
  if (input.lossBudget !== undefined && input.riskPerUnit === undefined)
    return fail('MISSING_RISK_PER_UNIT');
  const marginNotional = input.marginBudget * input.leverage;
  if (!Number.isFinite(marginNotional)) return fail('NONFINITE_SIZING');
  const ceiling = Math.min(
    marginNotional / input.entryPrice,
    input.maxNotional === undefined ? Infinity : input.maxNotional / input.entryPrice,
    input.maxQty ?? Infinity,
    input.maxQuantity ?? Infinity,
    input.lossBudget === undefined ? Infinity : input.lossBudget / input.riskPerUnit!,
  );
  const quantity = roundQuantityDown(ceiling, input);
  if (!Number.isFinite(quantity)) return fail('INVALID_QUANTITY_FILTERS');
  if (quantity <= 0) return fail('ZERO_QUANTITY');
  const notional = quantity * input.entryPrice;
  const marginRequired = notional / input.leverage;
  const maxLoss = input.riskPerUnit === undefined ? undefined : quantity * input.riskPerUnit;
  if (
    ![notional, marginRequired, ...(maxLoss === undefined ? [] : [maxLoss])].every(Number.isFinite)
  )
    return fail('NONFINITE_SIZING');
  if (notional < input.minNotional) return fail('BELOW_MIN_NOTIONAL');
  if (quantity < (input.minQty ?? 0)) return fail('BELOW_MIN_QUANTITY');
  if (
    quantity > ceiling ||
    notional > marginNotional ||
    marginRequired > input.marginBudget ||
    (input.maxNotional !== undefined && notional > input.maxNotional) ||
    (input.maxQty !== undefined && quantity > input.maxQty) ||
    (input.maxQuantity !== undefined && quantity > input.maxQuantity) ||
    (input.lossBudget !== undefined && maxLoss! > input.lossBudget)
  )
    return fail('EXCEEDS_CAP_AFTER_ROUNDING');
  return { valid: true, quantity, notional, marginRequired, maxLoss };
}

export interface SizingInput {
  /** Account balance in USDT. */
  balance: number;
  /** Maximum fraction of balance to risk per trade. */
  riskFraction: number;
  /** Entry price (executable/fresh quote). */
  entryPrice: number;
  /** Stop loss price. */
  stopPrice: number;
  /** Side: LONG or SHORT. Validates that stop is on correct side. */
  side: 'LONG' | 'SHORT';
  /** Leverage. */
  leverage: number;
  /** Fee buffer percentage (e.g., 0.001 for 0.1%). */
  feeBufferPct: number;
  /** Minimum notional for the symbol. */
  minNotional: number;
  /** Maximum notional for the leverage tier. */
  maxNotional: number;
  /** Step size for quantity rounding. */
  stepSize: number;
  /** Quantity precision (decimal places). */
  qtyPrecision: number;
}

export interface SizingResult {
  /** Final quantity to trade, rounded to stepSize. */
  quantity: number;
  /** Notional value of the trade. */
  notional: number;
  /** Risk per unit (distance to stop + fees). */
  riskPerUnit: number;
  /** Maximum loss if stop is hit. */
  maxLoss: number;
  /** Whether sizing was successful. */
  valid: boolean;
  reason?: string;
}

/**
 * Pure sizing engine: calculates position size based on loss-to-stop distance + costs.
 *
 * Formula:
 *   riskPerUnit = |entryPrice - stopPrice| + entryPrice * feeBufferPct * 2
 *   maxLossBudget = balance * riskFraction
 *   rawQty = maxLossBudget / riskPerUnit
 *   qty = floorToStep(min(rawQty, maxNotional / entryPrice, (balance * leverage) / entryPrice))
 *   notional = qty * entryPrice
 *
 * Constraints:
 *   - qty * entryPrice >= minNotional
 *   - notional <= maxNotional
 *   - notional <= balance * leverage
 *   - Geometry: stop must be below entry for LONG, above for SHORT
 *   - All limits re-checked after final rounding
 */
export function calculateSizing(input: SizingInput): SizingResult {
  const {
    balance,
    riskFraction,
    entryPrice,
    stopPrice,
    side,
    leverage,
    feeBufferPct,
    minNotional,
    maxNotional,
    stepSize,
    qtyPrecision,
  } = input;

  // Validate inputs.
  if (!Number.isFinite(balance) || balance <= 0) {
    return invalid('INVALID_BALANCE');
  }
  if (!Number.isFinite(riskFraction) || riskFraction <= 0 || riskFraction > 1) {
    return invalid('INVALID_RISK_FRACTION');
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return invalid('INVALID_ENTRY_PRICE');
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    return invalid('INVALID_STOP_PRICE');
  }
  if (side !== 'LONG' && side !== 'SHORT') {
    return invalid('INVALID_SIDE');
  }
  if (!Number.isFinite(leverage) || leverage <= 0) {
    return invalid('INVALID_LEVERAGE');
  }
  if (!Number.isFinite(feeBufferPct) || feeBufferPct < 0) {
    return invalid('INVALID_FEE_BUFFER');
  }
  if (!Number.isFinite(minNotional) || minNotional < 0) {
    return invalid('INVALID_MIN_NOTIONAL');
  }
  if (!Number.isFinite(maxNotional) || maxNotional <= 0) {
    return invalid('INVALID_MAX_NOTIONAL');
  }
  if (!Number.isFinite(stepSize) || stepSize <= 0) {
    return invalid('INVALID_STEP_SIZE');
  }

  // Geometry: stop must be on correct side for the given direction.
  if (side === 'LONG' && stopPrice >= entryPrice) {
    return invalid('STOP_ABOVE_ENTRY_FOR_LONG');
  }
  if (side === 'SHORT' && stopPrice <= entryPrice) {
    return invalid('STOP_BELOW_ENTRY_FOR_SHORT');
  }

  const distance = Math.abs(entryPrice - stopPrice);
  if (distance <= 0) {
    return invalid('STOP_EQUALS_ENTRY');
  }

  // Risk per unit: distance + round-trip fees.
  const riskPerUnit = distance + entryPrice * feeBufferPct * 2;
  if (riskPerUnit <= 0) {
    return invalid('RISK_PER_UNIT_ZERO');
  }

  // Legacy loss-fraction API retains its economic meaning; both modes share sizing/rounding.
  const sized = calculateMarginBudgetSizing({
    marginBudget: balance,
    entryPrice,
    leverage,
    minNotional,
    maxNotional,
    stepSize,
    qtyPrecision,
    lossBudget: balance * riskFraction,
    riskPerUnit,
  });
  if (!sized.valid) return invalid(sized.reason!);
  return {
    valid: true,
    quantity: sized.quantity,
    notional: sized.notional,
    riskPerUnit,
    maxLoss: sized.maxLoss!,
  };
}

function invalid(reason: string): SizingResult {
  return {
    quantity: 0,
    notional: 0,
    riskPerUnit: 0,
    maxLoss: 0,
    valid: false,
    reason,
  };
}
