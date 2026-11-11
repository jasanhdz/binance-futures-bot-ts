import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import { createHash } from 'node:crypto';

/**
 * Research-only evidence bounds shared by selection and paired replay. These are
 * inherited from the existing CURRENT input-freshness and preregistered selection
 * contracts; they are not calibrated from replay outcomes.
 */
export const PULLBACK_EXPERIMENT_V1 = Object.freeze({
  persistenceMs: 3_000,
  maxObservationGapMs: 2_000,
  maxTradeAgeMs: 2_000,
  minTradesPerWindow: 3,
  minSignedFlowRatio: 0.1,
  minSignedPriceResponseBps: 1,
});

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    return item;
  });
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const PULLBACK_EXPERIMENT_V1_SHA256 = sha256(canonical(PULLBACK_EXPERIMENT_V1));

export const MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1 = Object.freeze({
  schema: 'MICRO_PAIRED_REPLAY_EVIDENCE_V1' as const,
  maxBookAgeMs: defaultMicroBurstConfig().bookFreshnessMaxMs,
  maxObservationGapMs: PULLBACK_EXPERIMENT_V1.maxObservationGapMs,
  pullbackExperimentSha256: PULLBACK_EXPERIMENT_V1_SHA256,
  intervalClockContract: 'EVENT_AND_LOCAL_RECEIVE_BOUNDS_V1' as const,
  depthContinuityContract: 'USD_M_U_PU_SEQUENCE_FROM_PRE_INTERVAL_CHECKPOINT_V1' as const,
  noUpdateDisposition: 'UNKNOWN_NO_DEPTH_UPDATES_OBSERVED' as const,
});

export const MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256 = sha256(
  canonical(MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1),
);
