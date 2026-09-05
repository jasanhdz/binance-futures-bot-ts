export interface SizingInput {
  /** Account balance in USDT. */
  balance: number;
  /** Maximum fraction of balance to risk per trade. */
  riskFraction: number;
  /** Entry price (executable/fresh quote). */
  entryPrice: number;
  /** Stop loss price. */
  stopPrice: number;
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
 *   - Geometry: entry and stop must be on correct sides, no zero/negative distance
 */
export function calculateSizing(input: SizingInput): SizingResult {
  const {
    balance, riskFraction, entryPrice, stopPrice, leverage,
    feeBufferPct, minNotional, maxNotional, stepSize, qtyPrecision,
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

  // Geometry: entry and stop must be on correct sides.
  const distance = Math.abs(entryPrice - stopPrice);
  if (distance <= 0) {
    return invalid('STOP_EQUALS_ENTRY');
  }

  // Risk per unit: distance + round-trip fees.
  const riskPerUnit = distance + entryPrice * feeBufferPct * 2;
  if (riskPerUnit <= 0) {
    return invalid('RISK_PER_UNIT_ZERO');
  }

  // Maximum loss budget.
  const maxLossBudget = balance * riskFraction;

  // Raw quantity from risk budget.
  const rawQtyFromRisk = maxLossBudget / riskPerUnit;

  // Cap by maxNotional.
  const rawQtyFromNotional = maxNotional / entryPrice;

  // Cap by available margin (balance * leverage / price).
  const rawQtyFromMargin = (balance * leverage) / entryPrice;

  // Take the minimum.
  const uncappedQty = Math.min(rawQtyFromRisk, rawQtyFromNotional, rawQtyFromMargin);

  // Round down to stepSize.
  const scale = 10 ** qtyPrecision;
  const quantity = Math.floor(uncappedQty / stepSize) * stepSize;
  const roundedQty = Number(quantity.toFixed(qtyPrecision));

  // Check minimum notional.
  const notional = roundedQty * entryPrice;
  if (notional < minNotional) {
    return invalid('BELOW_MIN_NOTIONAL');
  }

  // Final max loss.
  const maxLoss = roundedQty * riskPerUnit;

  return {
    quantity: roundedQty,
    notional,
    riskPerUnit,
    maxLoss,
    valid: true,
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
