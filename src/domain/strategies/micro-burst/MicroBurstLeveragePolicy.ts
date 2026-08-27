import { LeverageTier, MicroBurstConfig } from './MicroBurstTypes';

interface LeverageTierResult {
  tier: LeverageTier;
  leverage: number;
  positionFraction: number;
}

export function selectLeverageTier(
  confirmationStrength: number,
  config: MicroBurstConfig,
): LeverageTierResult {
  if (confirmationStrength >= config.leverageTiers.high.minConfirmation) {
    return {
      tier: 'HIGH_CONFIRMATION',
      leverage: config.leverageTiers.high.leverage,
      positionFraction: config.leverageTiers.high.positionFraction,
    };
  }
  if (confirmationStrength >= config.leverageTiers.medium.minConfirmation) {
    return {
      tier: 'MEDIUM_CONFIRMATION',
      leverage: config.leverageTiers.medium.leverage,
      positionFraction: config.leverageTiers.medium.positionFraction,
    };
  }
  return {
    tier: 'NO_TRADE',
    leverage: 0,
    positionFraction: 0,
  };
}
