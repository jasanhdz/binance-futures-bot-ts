import { Strategy } from '../strategies/types';
import { BreakRetest } from '../strategies/break_retest';
import { FundingBasisMeanReversion } from '../strategies/funding_basis_mean_reversion';
import { MlProbabilityStrategy } from '../strategies/ml_probability';
import { MomentumBreakout } from '../strategies/momentum_breakout';
import { RangeBreakoutContinuation } from '../strategies/range_breakout_continuation';
import { TrendFollow } from '../strategies/trend_follow';
import { VolatilityTrendRide } from '../strategies/volatility_trend_ride';
import { VolumeProfilePullback } from '../strategies/volume_profile_pullback';
import { MeanReversionSnapback } from '../strategies/mean_reversion_snapback';
import { LiquiditySweepReversal } from '../strategies/liquidity_sweep_reversal';
import { StackingClassicStrategy } from '../strategies/stacking_classic';

const FACTORY_MAP: Record<string, () => Strategy> = {
  break_retest: () => BreakRetest,
  funding_basis_mean_reversion: () => FundingBasisMeanReversion,
  ml_probability: () => new MlProbabilityStrategy(),
  momentum_breakout: () => MomentumBreakout,
  range_breakout_continuation: () => RangeBreakoutContinuation,
  trend_follow: () => TrendFollow,
  volatility_trend_ride: () => VolatilityTrendRide,
  volume_profile_pullback: () => VolumeProfilePullback,
  mean_reversion_snapback: () => MeanReversionSnapback,
  liquidity_sweep_reversal: () => LiquiditySweepReversal,
  stacking_classic: () => StackingClassicStrategy,
};

export function listStrategies(): string[] {
  return Object.keys(FACTORY_MAP);
}

export function resolveStrategy(name: string): Strategy {
  const factory = FACTORY_MAP[name];
  if (!factory) {
    throw new Error(`Unknown strategy "${name}". Available: ${listStrategies().join(', ')}`);
  }
  return factory();
}
