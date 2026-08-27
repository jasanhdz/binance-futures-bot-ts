const BPS_PER_UNIT_RETURN = 10_000;

export function decimalReturnToBps(returnDecimal: number): number {
  return returnDecimal * BPS_PER_UNIT_RETURN;
}

export function bpsToDecimalReturn(bps: number): number {
  return bps / BPS_PER_UNIT_RETURN;
}

export function priceDistanceToBps(referencePrice: number, otherPrice: number): number {
  if (!Number.isFinite(referencePrice) || !Number.isFinite(otherPrice) || referencePrice <= 0) {
    return Number.NaN;
  }
  return decimalReturnToBps(Math.abs(otherPrice - referencePrice) / referencePrice);
}
