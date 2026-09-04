import type { Side } from '../../../core/types';
import type { MicroBurstFastMarketSnapshot } from '../application/MicroBurstFastMarketState';
import type { MicroBurstSlowMarketState } from '../domain/MicroBurstMarketState';

export const MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION = 'MICRO_OPPORTUNITY_FEATURE_V1' as const;
export const MICRO_OPPORTUNITY_SAMPLE_SCHEMA_VERSION = 1 as const;
export const MICRO_OPPORTUNITY_HORIZONS_MS = [10_000, 30_000, 60_000] as const;

export type MicroOpportunityHorizonMs = (typeof MICRO_OPPORTUNITY_HORIZONS_MS)[number];
export type MicroOpportunityOrientation = 'LONG' | 'SHORT';
export type MicroOpportunityPopulation = 'ENTRY_INTENT' | 'NO_TRADE' | 'NEUTRAL' | 'UNCLEAR';

export interface OpportunityFeatureVectorV1 {
  readonly priceReturn250msBps: number | null;
  readonly priceReturn1sBps: number | null;
  readonly priceReturn3sBps: number | null;
  readonly priceReturn5sBps: number | null;
  readonly priceReturn10sBps: number | null;
  readonly velocityBpsPerSecond: number | null;
  readonly accelerationBpsPerSecond2: number | null;
  readonly tradeIntensityPerSecond: number | null;
  readonly takerImbalance: number | null;
  readonly spreadBps: number | null;
  readonly signedBookImbalance: number | null;
  readonly bookImbalanceSlope: number | null;
  readonly temporalSweepDetected: 0 | 1 | null;
  readonly temporalAbsorptionDetected: 0 | 1 | null;
  readonly momentumStrength: number;
  readonly continuationScore: number;
  readonly momentumSlope1m: number;
  readonly momentumSlope3m: number;
  readonly momentumSlope5m: number;
  readonly bodyStrength: number;
  readonly wickRejectionUpper: number;
  readonly wickRejectionLower: number;
  readonly volumeExpansion: 0 | 1;
  readonly candleSequenceQuality: number;
  readonly distanceToSupportBps: number | null;
  readonly distanceToResistanceBps: number | null;
  readonly corridorWidthBps: number;
  readonly structuralPosition: 'near_support' | 'near_resistance' | 'mid_range';
  readonly microRegime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE';
  readonly btcRet1mBps: number | null;
  readonly btcRet3mBps: number | null;
  readonly btcRet5mBps: number | null;
  readonly btcAccelerationBps: number | null;
  readonly btcConflict: 0 | 1 | null;
  readonly tradeAgeMs: number | null;
  readonly bookAgeMs: number | null;
  readonly flowGapFree: 0 | 1;
  readonly flowWindowComplete: 0 | 1;
  readonly flowCapacityTruncated: 0 | 1;
}

export interface MicroOpportunityDecisionMetadata {
  readonly decision: 'ENTRY_INTENT' | 'NO_TRADE' | 'UNKNOWN';
  readonly side: Side | null;
  readonly reason: string | null;
  readonly confidence: number | null;
  readonly uniqueCandidateId: string | null;
}

export interface MicroOpportunityResearchSample {
  readonly schemaVersion: 1;
  readonly featureSchemaVersion: typeof MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION;
  readonly featureSchemaHash: string;
  readonly sampleId: string;
  readonly symbol: string;
  readonly sampledAtMs: number;
  readonly referencePrice: number;
  readonly slow: MicroBurstSlowMarketState;
  readonly fast: MicroBurstFastMarketSnapshot;
  readonly features: OpportunityFeatureVectorV1;
  /** Research metadata only. It is excluded from the V1 model feature list. */
  readonly stableMicroDecision: MicroOpportunityDecisionMetadata;
  /** Both orientations are labelable for every valid continuous state. */
  readonly candidateOrientations: readonly MicroOpportunityOrientation[];
  readonly population: MicroOpportunityPopulation;
}

export interface OpportunityOrientationOutcome {
  readonly mfeBps: number;
  readonly maeBps: number;
  readonly finalReturnBps: number;
  readonly timeToMfeMs: number;
  readonly timeToMaeMs: number;
}

export interface OpportunityEconomicOutcome {
  readonly netFavorableBps: Readonly<Record<'cost_0' | 'cost_10' | 'cost_14' | 'cost_20' | 'cost_30', number>>;
  readonly netPositive: Readonly<Record<'cost_0' | 'cost_10' | 'cost_14' | 'cost_20' | 'cost_30', boolean>>;
  readonly mfeMaeAsymmetryBps: number;
}

export interface MicroOpportunityHorizonLabel {
  readonly horizonMs: MicroOpportunityHorizonMs;
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly tradeCount: number;
  readonly long: OpportunityOrientationOutcome | null;
  readonly short: OpportunityOrientationOutcome | null;
  readonly longEconomic: OpportunityEconomicOutcome | null;
  readonly shortEconomic: OpportunityEconomicOutcome | null;
}

export interface MicroOpportunityLabeledSample {
  readonly sample: MicroOpportunityResearchSample;
  readonly labels: Readonly<Record<MicroOpportunityHorizonMs, MicroOpportunityHorizonLabel>>;
}
