import * as crypto from 'crypto';
import type { MicroBurstFastMarketSnapshot } from '../application/MicroBurstFastMarketState';
import type { MicroBurstSlowMarketState } from '../domain/MicroBurstMarketState';
import {
  buildOpportunityFeatureVectorV1,
  MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH,
} from './MicroOpportunityFeatureVector';
import {
  MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION,
  MICRO_OPPORTUNITY_SAMPLE_SCHEMA_VERSION,
  type MicroOpportunityDecisionMetadata,
  type MicroOpportunityOrientation,
  type MicroOpportunityPopulation,
  type MicroOpportunityResearchSample,
} from './MicroOpportunityTypes';

export const MICRO_OPPORTUNITY_RESEARCH_SAMPLE_INTERVAL_MS = 1_000;

export interface MicroOpportunitySampleInput {
  readonly symbol: string;
  readonly sampledAtMs: number;
  readonly slow: MicroBurstSlowMarketState | null;
  readonly fast: MicroBurstFastMarketSnapshot | null;
  readonly stableMicroDecision?: MicroOpportunityDecisionMetadata;
}

export interface MicroOpportunitySampleSink {
  /** Best-effort and non-blocking. False means observational persistence rejected the sample. */
  append(sample: MicroOpportunityResearchSample): boolean;
}

export interface MicroOpportunitySamplerHealth {
  readonly running: boolean;
  readonly sampled: number;
  readonly persisted: number;
  readonly skippedNoSlowState: number;
  readonly skippedNoFastPrice: number;
  readonly persistenceRejected: number;
  readonly sinkErrors: number;
  readonly inputErrors: number;
}

/**
 * Creates a causal research sample from the latest already-owned slow and fast state.
 * It does not call the exchange, mutate strategy decisions, or await persistence.
 */
export function buildMicroOpportunityResearchSample(
  input: MicroOpportunitySampleInput,
): MicroOpportunityResearchSample | null {
  if (!input.slow || !input.fast || input.fast.lastPrice === null) return null;
  if (input.slow.snapshotAtMs > input.sampledAtMs || input.fast.observedAtMs > input.sampledAtMs)
    return null;
  if (input.fast.lastTradeAtMs !== null && input.fast.lastTradeAtMs > input.sampledAtMs) return null;

  const decision: MicroOpportunityDecisionMetadata = input.stableMicroDecision ?? {
    decision: 'UNKNOWN',
    side: null,
    reason: null,
    confidence: null,
    uniqueCandidateId: null,
  };
  const population = populationForDecision(decision);
  const sampleId = crypto
    .createHash('sha256')
    .update(`${input.symbol}\u0000${input.sampledAtMs}\u0000${MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH}`)
    .digest('hex');

  return Object.freeze({
    schemaVersion: MICRO_OPPORTUNITY_SAMPLE_SCHEMA_VERSION,
    featureSchemaVersion: MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION,
    featureSchemaHash: MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH,
    sampleId,
    symbol: input.symbol,
    sampledAtMs: input.sampledAtMs,
    referencePrice: input.fast.lastPrice,
    slow: input.slow,
    fast: input.fast,
    features: buildOpportunityFeatureVectorV1(input.slow, input.fast),
    stableMicroDecision: decision,
    candidateOrientations: Object.freeze(['LONG', 'SHORT'] as MicroOpportunityOrientation[]),
    population,
  });
}

function populationForDecision(decision: MicroOpportunityDecisionMetadata): MicroOpportunityPopulation {
  if (decision.decision === 'ENTRY_INTENT') return 'ENTRY_INTENT';
  if (decision.decision === 'NO_TRADE') return 'NO_TRADE';
  return decision.decision === 'UNKNOWN' ? 'UNCLEAR' : 'NEUTRAL';
}

/**
 * Independent 1 s observational loop. Reads are synchronous in-memory callbacks and persistence is
 * deliberately best-effort so research backpressure cannot block the trading event loop.
 */
export class MicroOpportunityResearchSampler {
  private timer: NodeJS.Timeout | null = null;
  private sampled = 0;
  private persisted = 0;
  private skippedNoSlowState = 0;
  private skippedNoFastPrice = 0;
  private persistenceRejected = 0;
  private sinkErrors = 0;
  private inputErrors = 0;
  private inTick = false;

  constructor(
    private readonly symbols: readonly string[],
    private readonly now: () => number,
    private readonly readInput: (symbol: string, sampledAtMs: number) => MicroOpportunitySampleInput,
    private readonly sink: MicroOpportunitySampleSink,
    private readonly intervalMs = MICRO_OPPORTUNITY_RESEARCH_SAMPLE_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for deterministic tests/replay; production timer calls the same path. */
  tick(): void {
    if (this.inTick) return;
    this.inTick = true;
    const sampledAtMs = this.now();
    try {
      for (const symbol of this.symbols) {
        let input: MicroOpportunitySampleInput;
        try {
          input = this.readInput(symbol, sampledAtMs);
        } catch {
          this.inputErrors++;
          continue;
        }
        if (!input.slow) {
          this.skippedNoSlowState++;
          continue;
        }
        if (!input.fast || input.fast.lastPrice === null) {
          this.skippedNoFastPrice++;
          continue;
        }
        const sample = buildMicroOpportunityResearchSample(input);
        if (!sample) continue;
        this.sampled++;
        try {
          if (this.sink.append(sample)) this.persisted++;
          else this.persistenceRejected++;
        } catch {
          this.sinkErrors++;
        }
      }
    } finally {
      this.inTick = false;
    }
  }

  getHealth(): MicroOpportunitySamplerHealth {
    return {
      running: this.timer !== null,
      sampled: this.sampled,
      persisted: this.persisted,
      skippedNoSlowState: this.skippedNoSlowState,
      skippedNoFastPrice: this.skippedNoFastPrice,
      persistenceRejected: this.persistenceRejected,
      sinkErrors: this.sinkErrors,
      inputErrors: this.inputErrors,
    };
  }
}
