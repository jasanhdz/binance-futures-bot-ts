import * as crypto from 'crypto';
import type { MicroBurstFastMarketSnapshot } from '../application/MicroBurstFastMarketState';
import type { MicroBurstSlowMarketState } from '../domain/MicroBurstMarketState';
import {
  MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION,
  type OpportunityFeatureVectorV1,
} from './MicroOpportunityTypes';

const FEATURE_NAMES: readonly (keyof OpportunityFeatureVectorV1)[] = [
  'priceReturn250msBps',
  'priceReturn1sBps',
  'priceReturn3sBps',
  'priceReturn5sBps',
  'priceReturn10sBps',
  'velocityBpsPerSecond',
  'accelerationBpsPerSecond2',
  'tradeIntensityPerSecond',
  'takerImbalance',
  'spreadBps',
  'signedBookImbalance',
  'bookImbalanceSlope',
  'temporalSweepDetected',
  'temporalAbsorptionDetected',
  'momentumStrength',
  'continuationScore',
  'momentumSlope1m',
  'momentumSlope3m',
  'momentumSlope5m',
  'bodyStrength',
  'wickRejectionUpper',
  'wickRejectionLower',
  'volumeExpansion',
  'candleSequenceQuality',
  'distanceToSupportBps',
  'distanceToResistanceBps',
  'corridorWidthBps',
  'structuralPosition',
  'microRegime',
  'btcRet1mBps',
  'btcRet3mBps',
  'btcRet5mBps',
  'btcAccelerationBps',
  'btcConflict',
  'tradeAgeMs',
  'bookAgeMs',
  'flowGapFree',
  'flowWindowComplete',
  'flowCapacityTruncated',
] as const;

export const MICRO_OPPORTUNITY_FEATURE_NAMES = Object.freeze([...FEATURE_NAMES]);
export const MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH = crypto
  .createHash('sha256')
  .update(`${MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION}\n${FEATURE_NAMES.join('\n')}`)
  .digest('hex');

export function buildOpportunityFeatureVectorV1(
  slow: MicroBurstSlowMarketState,
  fast: MicroBurstFastMarketSnapshot,
): OpportunityFeatureVectorV1 {
  const livePrice = fast.lastPrice;
  const support = slow.levels.nearest.support?.price ?? null;
  const resistance = slow.levels.nearest.resistance?.price ?? null;
  const btc = slow.btcContext;

  return Object.freeze({
    priceReturn250msBps: fast.returnsBps.ms250,
    priceReturn1sBps: fast.returnsBps.s1,
    priceReturn3sBps: fast.returnsBps.s3,
    priceReturn5sBps: fast.returnsBps.s5,
    priceReturn10sBps: fast.returnsBps.s10,
    velocityBpsPerSecond: fast.velocityBpsPerSecond,
    accelerationBpsPerSecond2: fast.accelerationBpsPerSecond2,
    tradeIntensityPerSecond: fast.tradeIntensityPerSecond,
    takerImbalance: fast.takerImbalance,
    spreadBps: fast.spreadBps,
    signedBookImbalance: fast.signedBookImbalance,
    bookImbalanceSlope: fast.bookImbalanceSlope,
    temporalSweepDetected: booleanNumber(fast.temporalSweepDetected),
    temporalAbsorptionDetected: booleanNumber(fast.temporalAbsorptionDetected),
    momentumStrength: slow.momentum.strength,
    continuationScore: slow.momentum.continuationScore,
    momentumSlope1m: slow.momentum.slope1m,
    momentumSlope3m: slow.momentum.slope3m,
    momentumSlope5m: slow.momentum.slope5m,
    bodyStrength: slow.momentum.bodyStrength,
    wickRejectionUpper: slow.momentum.wickRejectionUpper,
    wickRejectionLower: slow.momentum.wickRejectionLower,
    volumeExpansion: slow.momentum.volumeExpansion ? 1 : 0,
    candleSequenceQuality: slow.momentum.candleSequenceQuality,
    distanceToSupportBps: liveDistanceBps(livePrice, support),
    distanceToResistanceBps: liveDistanceBps(livePrice, resistance),
    corridorWidthBps: slow.levels.nearest.corridorWidthBps,
    structuralPosition: slow.structuralPosition,
    microRegime: slow.microRegime,
    btcRet1mBps: btc ? btc.ret1m * 10_000 : null,
    btcRet3mBps: btc ? btc.ret3m * 10_000 : null,
    btcRet5mBps: btc ? btc.ret5m * 10_000 : null,
    btcAccelerationBps: btc ? btc.acceleration * 10_000 : null,
    btcConflict: btc ? (btc.conflictFlag ? 1 : 0) : null,
    tradeAgeMs: fast.dataQuality.tradeAgeMs,
    bookAgeMs: fast.dataQuality.bookAgeMs,
    flowGapFree: fast.dataQuality.gapFree ? 1 : 0,
    flowWindowComplete: fast.dataQuality.windowComplete ? 1 : 0,
    flowCapacityTruncated: fast.dataQuality.capacityTruncated ? 1 : 0,
  });
}

function booleanNumber(value: boolean | null): 0 | 1 | null {
  return value === null ? null : value ? 1 : 0;
}

function liveDistanceBps(price: number | null, level: number | null): number | null {
  if (price === null || level === null || !Number.isFinite(price) || price <= 0) return null;
  return (Math.abs(level - price) / price) * 10_000;
}
