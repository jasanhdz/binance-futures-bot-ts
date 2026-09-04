import * as crypto from 'crypto';
import {
  MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION,
  MICRO_OPPORTUNITY_HORIZONS_MS,
  type MicroOpportunityHorizonMs,
  type MicroOpportunityLabeledSample,
  type MicroOpportunityResearchSample,
} from './MicroOpportunityTypes';
import {
  MICRO_OPPORTUNITY_FEATURE_NAMES,
  MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH,
} from './MicroOpportunityFeatureVector';

export const MICRO_OPPORTUNITY_SPLIT_EMBARGO_MS = 60_000;

export interface OpportunityCausalityAuditResult {
  readonly valid: boolean;
  readonly invalidSampleIds: readonly string[];
  readonly reasons: Readonly<Record<string, readonly string[]>>;
}

export interface OpportunityDatasetQualityReport {
  readonly totalSamples: number;
  readonly symbols: Readonly<Record<string, number>>;
  readonly decisions: Readonly<Record<string, number>>;
  readonly duplicateSampleIds: number;
  readonly invalidFeatureSamples: number;
  readonly horizonValidity: Readonly<
    Record<MicroOpportunityHorizonMs, { valid: number; invalid: number; invalidReasons: Record<string, number> }>
  >;
}

export interface OpportunityDatasetSplit {
  readonly train: readonly MicroOpportunityLabeledSample[];
  readonly validation: readonly MicroOpportunityLabeledSample[];
  readonly holdout: readonly MicroOpportunityLabeledSample[];
  readonly purged: readonly MicroOpportunityLabeledSample[];
  readonly trainEndExclusiveMs: number;
  readonly validationEndExclusiveMs: number;
  readonly embargoMs: number;
}

export interface OpportunityDatasetManifestV1 {
  readonly schemaVersion: 1;
  readonly datasetVersion: string;
  readonly featureSchemaVersion: typeof MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION;
  readonly featureSchemaHash: string;
  readonly featureNames: readonly string[];
  readonly codeCommitSha: string;
  readonly configHash: string;
  readonly symbols: readonly string[];
  readonly firstSampleAtMs: number | null;
  readonly lastSampleAtMs: number | null;
  readonly rowCounts: {
    readonly total: number;
    readonly train: number;
    readonly validation: number;
    readonly holdout: number;
    readonly purged: number;
  };
  readonly split: {
    readonly trainFraction: 0.6;
    readonly validationFraction: 0.2;
    readonly holdoutFraction: 0.2;
    readonly embargoMs: number;
    readonly trainEndExclusiveMs: number;
    readonly validationEndExclusiveMs: number;
  };
  readonly horizonsMs: readonly number[];
  readonly costScenariosBps: readonly [0, 10, 14, 20, 30];
  readonly manifestHash: string;
}

export function auditOpportunitySampleCausality(
  samples: readonly MicroOpportunityResearchSample[],
): OpportunityCausalityAuditResult {
  const reasons: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const sample of samples) {
    const sampleReasons: string[] = [];
    if (seen.has(sample.sampleId)) sampleReasons.push('DUPLICATE_SAMPLE_ID');
    seen.add(sample.sampleId);
    if (sample.featureSchemaVersion !== MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION)
      sampleReasons.push('FEATURE_SCHEMA_VERSION_MISMATCH');
    if (sample.featureSchemaHash !== MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH)
      sampleReasons.push('FEATURE_SCHEMA_HASH_MISMATCH');
    if (sample.slow.snapshotAtMs > sample.sampledAtMs) sampleReasons.push('SLOW_STATE_FROM_FUTURE');
    if (sample.slow.referencePriceObservedAtMs > sample.sampledAtMs)
      sampleReasons.push('SLOW_REFERENCE_PRICE_FROM_FUTURE');
    if (sample.fast.observedAtMs > sample.sampledAtMs) sampleReasons.push('FAST_STATE_FROM_FUTURE');
    if (sample.fast.lastTradeAtMs !== null && sample.fast.lastTradeAtMs > sample.sampledAtMs)
      sampleReasons.push('TRADE_FROM_FUTURE');
    const levelTimes = sample.slow.levels.levels.map((level) => level.availableAtMs);
    if (levelTimes.some((availableAtMs) => availableAtMs > sample.sampledAtMs))
      sampleReasons.push('SUPPORT_RESISTANCE_FROM_FUTURE');
    if (sample.fast.dataQuality.tradeAgeMs !== null && sample.fast.dataQuality.tradeAgeMs < 0)
      sampleReasons.push('NEGATIVE_TRADE_AGE');
    if (sample.fast.dataQuality.bookAgeMs !== null && sample.fast.dataQuality.bookAgeMs < 0)
      sampleReasons.push('NEGATIVE_BOOK_AGE');
    if (!Number.isFinite(sample.referencePrice) || sample.referencePrice <= 0)
      sampleReasons.push('INVALID_REFERENCE_PRICE');
    if (sampleReasons.length) reasons[sample.sampleId] = sampleReasons;
  }
  const invalidSampleIds = Object.keys(reasons);
  return { valid: invalidSampleIds.length === 0, invalidSampleIds, reasons };
}

export function auditOpportunityDatasetQuality(
  rows: readonly MicroOpportunityLabeledSample[],
): OpportunityDatasetQualityReport {
  const symbols: Record<string, number> = {};
  const decisions: Record<string, number> = {};
  const seen = new Set<string>();
  let duplicateSampleIds = 0;
  let invalidFeatureSamples = 0;
  const horizonValidity = Object.fromEntries(
    MICRO_OPPORTUNITY_HORIZONS_MS.map((horizon) => [
      horizon,
      { valid: 0, invalid: 0, invalidReasons: {} as Record<string, number> },
    ]),
  ) as OpportunityDatasetQualityReport['horizonValidity'];

  for (const row of rows) {
    const sample = row.sample;
    symbols[sample.symbol] = (symbols[sample.symbol] ?? 0) + 1;
    decisions[sample.stableMicroDecision.decision] =
      (decisions[sample.stableMicroDecision.decision] ?? 0) + 1;
    if (seen.has(sample.sampleId)) duplicateSampleIds++;
    seen.add(sample.sampleId);
    if (!auditOpportunitySampleCausality([sample]).valid) invalidFeatureSamples++;
    for (const horizon of MICRO_OPPORTUNITY_HORIZONS_MS) {
      const label = row.labels[horizon];
      const bucket = horizonValidity[horizon] as {
        valid: number;
        invalid: number;
        invalidReasons: Record<string, number>;
      };
      if (label.valid) bucket.valid++;
      else {
        bucket.invalid++;
        const reason = label.invalidReason ?? 'UNKNOWN';
        bucket.invalidReasons[reason] = (bucket.invalidReasons[reason] ?? 0) + 1;
      }
    }
  }

  return {
    totalSamples: rows.length,
    symbols,
    decisions,
    duplicateSampleIds,
    invalidFeatureSamples,
    horizonValidity,
  };
}

/** Chronological 60/20/20 split with a 60 s purge around both boundaries. */
export function splitOpportunityDataset(
  input: readonly MicroOpportunityLabeledSample[],
  embargoMs = MICRO_OPPORTUNITY_SPLIT_EMBARGO_MS,
): OpportunityDatasetSplit {
  const rows = input.slice().sort((a, b) => a.sample.sampledAtMs - b.sample.sampledAtMs);
  if (rows.length === 0)
    return {
      train: [],
      validation: [],
      holdout: [],
      purged: [],
      trainEndExclusiveMs: 0,
      validationEndExclusiveMs: 0,
      embargoMs,
    };

  const trainBoundaryIndex = Math.min(rows.length - 1, Math.floor(rows.length * 0.6));
  const validationBoundaryIndex = Math.min(rows.length - 1, Math.floor(rows.length * 0.8));
  const trainEndExclusiveMs = rows[trainBoundaryIndex].sample.sampledAtMs;
  const validationEndExclusiveMs = rows[validationBoundaryIndex].sample.sampledAtMs;
  const train: MicroOpportunityLabeledSample[] = [];
  const validation: MicroOpportunityLabeledSample[] = [];
  const holdout: MicroOpportunityLabeledSample[] = [];
  const purged: MicroOpportunityLabeledSample[] = [];

  for (const row of rows) {
    const t = row.sample.sampledAtMs;
    if (
      Math.abs(t - trainEndExclusiveMs) < embargoMs ||
      Math.abs(t - validationEndExclusiveMs) < embargoMs
    ) {
      purged.push(row);
    } else if (t < trainEndExclusiveMs) train.push(row);
    else if (t < validationEndExclusiveMs) validation.push(row);
    else holdout.push(row);
  }
  return {
    train,
    validation,
    holdout,
    purged,
    trainEndExclusiveMs,
    validationEndExclusiveMs,
    embargoMs,
  };
}

export function buildOpportunityDatasetManifestV1(input: {
  datasetVersion: string;
  codeCommitSha: string;
  configHash: string;
  split: OpportunityDatasetSplit;
}): OpportunityDatasetManifestV1 {
  const all = [...input.split.train, ...input.split.validation, ...input.split.holdout, ...input.split.purged]
    .slice()
    .sort((a, b) => a.sample.sampledAtMs - b.sample.sampledAtMs);
  const body = {
    schemaVersion: 1 as const,
    datasetVersion: input.datasetVersion,
    featureSchemaVersion: MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION,
    featureSchemaHash: MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH,
    featureNames: MICRO_OPPORTUNITY_FEATURE_NAMES,
    codeCommitSha: input.codeCommitSha,
    configHash: input.configHash,
    symbols: [...new Set(all.map((row) => row.sample.symbol))].sort(),
    firstSampleAtMs: all[0]?.sample.sampledAtMs ?? null,
    lastSampleAtMs: all[all.length - 1]?.sample.sampledAtMs ?? null,
    rowCounts: {
      total: all.length,
      train: input.split.train.length,
      validation: input.split.validation.length,
      holdout: input.split.holdout.length,
      purged: input.split.purged.length,
    },
    split: {
      trainFraction: 0.6 as const,
      validationFraction: 0.2 as const,
      holdoutFraction: 0.2 as const,
      embargoMs: input.split.embargoMs,
      trainEndExclusiveMs: input.split.trainEndExclusiveMs,
      validationEndExclusiveMs: input.split.validationEndExclusiveMs,
    },
    horizonsMs: [...MICRO_OPPORTUNITY_HORIZONS_MS],
    costScenariosBps: [0, 10, 14, 20, 30] as const,
  };
  const manifestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return Object.freeze({ ...body, manifestHash });
}
