export interface MicroBurstContextualRiskPolicy {
  sizingMode: 'MARGIN_FRACTION';
  marginFraction: number;
  mediumLeverage: 20;
  highLeverage: 30;
  maxConsecutiveNetLosses: 3;
  resetMode: 'SIGNED_OPERATOR';
  feeReserveBps: number;
  stopStressBps: number;
}

export function validMicroBurstContextualRiskPolicy(
  value: unknown,
): value is MicroBurstContextualRiskPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const risk = value as MicroBurstContextualRiskPolicy;
  return (
    Object.keys(risk).length === 8 &&
    risk.sizingMode === 'MARGIN_FRACTION' &&
    Number.isFinite(risk.marginFraction) &&
    risk.marginFraction > 0 &&
    risk.marginFraction <= 0.9 &&
    risk.mediumLeverage === 20 &&
    risk.highLeverage === 30 &&
    risk.maxConsecutiveNetLosses === 3 &&
    risk.resetMode === 'SIGNED_OPERATOR' &&
    Number.isFinite(risk.feeReserveBps) &&
    risk.feeReserveBps > 0 &&
    Number.isFinite(risk.stopStressBps) &&
    risk.stopStressBps >= 0
  );
}
