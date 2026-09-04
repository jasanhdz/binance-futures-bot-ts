import type {
  BtcContext,
  MicroBurstContext,
  MicroMomentumSignal,
  MicroRegime,
  SupportResistanceResult,
  StructuralPosition,
} from './MicroBurstTypes';

/**
 * Candle/structure-derived state that changes materially slower than aggTrade/depth state.
 *
 * This is an observational projection only. It does not change the existing Micro Burst
 * decision price or entry/exit policy. V1 Opportunity research composes this state with a
 * separately sampled fast state so high-frequency research never needs to reinterpret
 * closed-candle causal semantics.
 */
export interface MicroBurstSlowMarketState {
  readonly schemaVersion: 1;
  readonly symbol: string;
  readonly snapshotAtMs: number;
  readonly referencePrice: number;
  readonly referencePriceObservedAtMs: number;
  readonly structuralPosition: StructuralPosition;
  readonly levels: SupportResistanceResult;
  readonly momentum: MicroMomentumSignal;
  readonly btcContext: BtcContext | null;
  readonly structuralClarity: boolean;
  readonly microRegime: MicroRegime;
  readonly dataQuality: {
    readonly latestClosed1mAt: number;
    readonly latestClosed3mAt: number;
    readonly latestClosed5mAt: number;
    readonly freshness1mMs: number;
    readonly freshness3mMs: number;
    readonly freshness5mMs: number;
    readonly levelsAvailableAt: number | null;
    readonly contextValid: boolean;
    readonly invalidReasons: readonly string[];
  };
}

/**
 * Pure causal projection from the existing stable MicroBurstContext.
 * Book and aggTrade fields are deliberately excluded: they belong to FastMarketState.
 */
export function projectMicroBurstSlowMarketState(
  context: MicroBurstContext,
): MicroBurstSlowMarketState {
  const state: MicroBurstSlowMarketState = {
    schemaVersion: 1,
    symbol: context.symbol,
    snapshotAtMs: context.timestamp,
    referencePrice: context.decisionPrice.price,
    referencePriceObservedAtMs: context.decisionPrice.observedAtMs,
    structuralPosition: context.levels.nearest.structuralPosition,
    levels: context.levels,
    momentum: context.momentum,
    btcContext: context.btcContext,
    structuralClarity: context.structuralClarity,
    microRegime: context.microRegime,
    dataQuality: {
      latestClosed1mAt: context.dataQuality.latestClosed1mAt,
      latestClosed3mAt: context.dataQuality.latestClosed3mAt,
      latestClosed5mAt: context.dataQuality.latestClosed5mAt,
      freshness1mMs: context.dataQuality.freshness1mMs,
      freshness3mMs: context.dataQuality.freshness3mMs,
      freshness5mMs: context.dataQuality.freshness5mMs,
      levelsAvailableAt: context.dataQuality.levelsAvailableAt,
      contextValid: context.dataQuality.contextValid,
      invalidReasons: [...context.dataQuality.invalidReasons],
    },
  };
  return Object.freeze(state);
}
