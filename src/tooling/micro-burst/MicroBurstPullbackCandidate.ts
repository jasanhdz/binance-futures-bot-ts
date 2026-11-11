import type { MicroBurstEntryDecision } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import {
  isVerifiedCaptureSession,
  isVerifiedDecisionRecord,
  isVerifiedTradeEvidence,
  readVerifiedPullbackEvidence,
  type VerifiedCaptureSession,
} from './MicroBurstCaptureSession';
import {
  decodeValidatedPatternReplay,
  historicalDecisionAgrees,
} from './MicroBurstPatternComparison';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import { PULLBACK_EXPERIMENT_V1 } from './MicroBurstReplayEvidenceContract';
import { createHash } from 'node:crypto';

export { PULLBACK_EXPERIMENT_V1 } from './MicroBurstReplayEvidenceContract';

export interface PullbackTrade {
  aggregateTradeId: number;
  eventTime: number;
  receivedAtMs: number;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
}

export interface PullbackEvidence {
  /** Derived by openVerifiedCaptureSession/readVerifiedPullbackEvidence, never caller-authored. */
  coverageVerified: boolean;
  coverageStartedAtMs: number;
  coverageThroughMs: number;
  gapFree: boolean;
  sequenceValid: boolean;
  capacityTruncated: boolean;
  invalidReason: string | null;
  trades: readonly PullbackTrade[];
  sourceArtifactHash: string;
  sessionManifestSha256: string;
  decisionId: string;
  decisionInputSha256: string;
  verification: 'ARCHIVE_SESSION_AND_TRADE_SEQUENCE_RECHECKED';
}

export interface UnverifiedPullbackEvidence {
  coverageVerified: boolean;
  coverageStartedAtMs: number;
  coverageThroughMs: number;
  gapFree: boolean;
  sequenceValid: boolean;
  capacityTruncated: boolean;
  invalidReason: string | null;
  trades: readonly PullbackTrade[];
}

export interface PullbackExperimentConfig {
  persistenceMs: number;
  maxObservationGapMs: number;
  maxTradeAgeMs: number;
  minTradesPerWindow: number;
  minSignedFlowRatio: number;
  minSignedPriceResponseBps: number;
}

export interface PullbackWindow {
  horizonMs: number;
  tradeCount: number;
  signedFlowRatio: number;
  signedPriceResponseBps: number;
}

export interface PullbackObservation {
  authority: 'SHADOW_ONLY';
  candidateVersion: 'PULLBACK_CONTINUATION_V1';
  symbol: string;
  sourceDecisionId: string;
  sourceArtifactHash: string;
  sessionManifestSha256: string;
  decisionInputSha256: string;
  experimentConfigSha256: string;
  tradeEvidenceSha256: string;
  evidenceSha256: string;
  observedAtMs: number;
  exchangeAsOfMs: number;
  baseline: MicroBurstEntryDecision;
  candidate: 'REJECT' | 'WAIT' | 'QUALIFIED';
  disposition: 'STRATEGY_REJECTED' | 'WAITING' | 'QUALIFIED' | 'DATA_UNAVAILABLE';
  reason: string;
  windows: readonly PullbackWindow[];
  /** No order intent, sizing or PnL is produced by this selector. */
  executionEligibility: 'NOT_EVALUATED';
}

interface Persistence {
  key: string;
  startedAtMs: number;
  lastAtMs: number;
  lastExchangeMs: number;
  lastTradeId: number;
}

const verifiedPullbackObservations = new WeakSet<object>();
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
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
const dataUnavailableReasons = new Set([
  'FLOW_EVIDENCE_NOT_ARCHIVE_VERIFIED',
  'INVALID_CLOCK',
  'FLOW_COVERAGE_UNKNOWN',
  'CAPTURE_SESSION_RANGE_MISSING',
  'ARCHIVED_FEED_GAP',
  'PREWINDOW_ANCHOR_MISSING',
  'TRADE_SEQUENCE_INVALID',
  'INVALID_TRADE_CLOCK',
  'RECENT_FLOW_STALE',
  'RECENT_FLOW_INSUFFICIENT',
  'RECENT_FLOW_INVALID',
  'NO_NEW_TRADE_EVIDENCE',
  'NON_MONOTONIC_OBSERVATION',
]);

export function isVerifiedPullbackObservation(value: unknown): value is PullbackObservation {
  return Boolean(value && typeof value === 'object' && verifiedPullbackObservations.has(value));
}

/** Offline/shadow selector. No exchange, runtime config, persistence or execution imports. */
export class MicroBurstPullbackCandidate {
  private readonly states = new Map<string, Persistence>();
  private readonly config: Readonly<PullbackExperimentConfig>;

  constructor(config: Readonly<PullbackExperimentConfig> = PULLBACK_EXPERIMENT_V1) {
    if (
      !Object.values(config).every(Number.isFinite) ||
      config.persistenceMs <= 0 ||
      config.maxObservationGapMs <= 0 ||
      config.maxTradeAgeMs <= 0 ||
      !Number.isInteger(config.minTradesPerWindow) ||
      config.minTradesPerWindow < 2 ||
      config.minSignedFlowRatio <= 0 ||
      config.minSignedFlowRatio > 1 ||
      config.minSignedPriceResponseBps <= 0
    )
      throw new Error('INVALID_PULLBACK_EXPERIMENT_CONFIG');
    this.config = Object.freeze({ ...config });
  }

  async evaluate(
    session: VerifiedCaptureSession,
    record: StrategyDecisionEvidenceV2,
  ): Promise<PullbackObservation> {
    if (!isVerifiedCaptureSession(session) || !isVerifiedDecisionRecord(record))
      throw new Error('PULLBACK_REPLAY_REQUIRES_VERIFIED_CAPTURE_RECORD');
    const replayResult = decodeValidatedPatternReplay(
      record.diagnostics?.strategyInputReplay,
      record.strategy.codeCommitSha,
    );
    if (!historicalDecisionAgrees(record, replayResult.current))
      throw new Error(`STORED_CURRENT_DECISION_MISMATCH:${record.decisionId}`);
    const replay = replayResult.replay;
    const observedAtMs = replay.context.observedAtMs;
    const exchangeAsOfMs = replay.context.exchangeObservedAtMs;
    if (!Number.isFinite(observedAtMs) || !Number.isFinite(exchangeAsOfMs))
      throw new Error(`PULLBACK_DECISION_CLOCK_INVALID:${record.decisionId}`);
    const evidence = await readVerifiedPullbackEvidence(
      session,
      record,
      exchangeAsOfMs!,
      observedAtMs!,
    );
    return this.observeVerified({
      symbol: record.symbol,
      decisionId: record.decisionId,
      regime: replay.context.microRegime,
      baseline: replayResult.current,
      observedAtMs: observedAtMs!,
      exchangeAsOfMs: exchangeAsOfMs!,
      evidence,
    });
  }

  private observeVerified(input: {
    symbol: string;
    decisionId: string;
    regime: string;
    baseline: MicroBurstEntryDecision;
    observedAtMs: number;
    exchangeAsOfMs: number;
    evidence: PullbackEvidence;
  }): PullbackObservation {
    const { symbol, baseline, observedAtMs: now, exchangeAsOfMs: asOf, evidence } = input;
    const windows: PullbackWindow[] = [];
    const experimentConfigSha256 = sha256(canonical(this.config));
    const tradeEvidenceSha256 = sha256(
      canonical({
        sourceArtifactHash: evidence.sourceArtifactHash,
        sessionManifestSha256: evidence.sessionManifestSha256,
        decisionId: evidence.decisionId,
        decisionInputSha256: evidence.decisionInputSha256,
        coverageStartedAtMs: evidence.coverageStartedAtMs,
        coverageThroughMs: evidence.coverageThroughMs,
        coverageVerified: evidence.coverageVerified,
        gapFree: evidence.gapFree,
        sequenceValid: evidence.sequenceValid,
        capacityTruncated: evidence.capacityTruncated,
        invalidReason: evidence.invalidReason,
        trades: evidence.trades,
      }),
    );
    const result = (
      candidate: PullbackObservation['candidate'],
      reason: string,
    ): PullbackObservation => {
      const body: Omit<PullbackObservation, 'evidenceSha256'> = {
        authority: 'SHADOW_ONLY',
        candidateVersion: 'PULLBACK_CONTINUATION_V1',
        symbol,
        sourceDecisionId: input.decisionId,
        sourceArtifactHash: evidence.sourceArtifactHash,
        sessionManifestSha256: evidence.sessionManifestSha256,
        decisionInputSha256: evidence.decisionInputSha256,
        experimentConfigSha256,
        tradeEvidenceSha256,
        observedAtMs: now,
        exchangeAsOfMs: asOf,
        baseline,
        candidate,
        disposition:
          candidate === 'QUALIFIED'
            ? 'QUALIFIED'
            : candidate === 'WAIT'
              ? 'WAITING'
              : dataUnavailableReasons.has(reason)
                ? 'DATA_UNAVAILABLE'
                : 'STRATEGY_REJECTED',
        reason,
        windows: Object.freeze(windows.slice()),
        executionEligibility: 'NOT_EVALUATED',
      };
      const observation: PullbackObservation = Object.freeze({
        ...body,
        evidenceSha256: sha256(canonical(body)),
      });
      verifiedPullbackObservations.add(observation);
      return observation;
    };
    const reject = (reason: string): PullbackObservation => {
      this.states.delete(symbol);
      return result('REJECT', reason);
    };
    if (!isVerifiedTradeEvidence(evidence)) return reject('FLOW_EVIDENCE_NOT_ARCHIVE_VERIFIED');
    if (![now, asOf].every((n) => Number.isFinite(n) && n > 0)) return reject('INVALID_CLOCK');
    if (baseline.action !== 'ENTRY_INTENT') return reject('BASELINE_REJECTED');
    const side = baseline.side;
    const setup = baseline.diagnostics.setup;
    if (
      !side ||
      !['TREND_RETEST_CONTINUATION', 'BREAKOUT_RETEST_CONTINUATION'].includes(String(setup))
    )
      return reject('NOT_CONTINUATION_RETEST');
    if (input.regime !== (side === 'LONG' ? 'TRENDING_UP' : 'TRENDING_DOWN'))
      return reject('REGIME_NOT_ALIGNED');
    const episodeId = baseline.diagnostics.episodeId;
    if (typeof episodeId !== 'string' || !episodeId) return reject('EPISODE_MISSING');
    if (
      !evidence.coverageVerified ||
      !evidence.gapFree ||
      !evidence.sequenceValid ||
      evidence.capacityTruncated ||
      ![evidence.coverageStartedAtMs, evidence.coverageThroughMs].every(Number.isFinite) ||
      evidence.coverageStartedAtMs > asOf - 60_000 ||
      evidence.coverageThroughMs < asOf
    )
      return reject(evidence.invalidReason ?? 'FLOW_COVERAGE_UNKNOWN');
    if (
      evidence.trades.some((t) => !Number.isFinite(t.eventTime) || !Number.isFinite(t.receivedAtMs))
    )
      return reject('INVALID_TRADE_CLOCK');
    // Exclude not-yet-received events as well as exchange events beyond the decision.
    const trades = evidence.trades.filter(
      (t) => t.eventTime <= asOf && t.receivedAtMs <= now && t.eventTime >= asOf - 60_000,
    );
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const p = trades[i - 1];
      if (
        ![t.eventTime, t.receivedAtMs, t.price, t.quantity].every(
          (n) => Number.isFinite(n) && n > 0,
        ) ||
        !Number.isSafeInteger(t.aggregateTradeId) ||
        t.aggregateTradeId < 0 ||
        typeof t.isBuyerMaker !== 'boolean' ||
        (p && (t.aggregateTradeId !== p.aggregateTradeId + 1 || t.eventTime < p.eventTime))
      )
        return reject('TRADE_SEQUENCE_INVALID');
    }
    const latest = trades[trades.length - 1];
    if (
      !latest ||
      asOf - latest.eventTime > this.config.maxTradeAgeMs ||
      now - latest.receivedAtMs > this.config.maxTradeAgeMs
    )
      return reject('RECENT_FLOW_STALE');
    const sign = side === 'LONG' ? 1 : -1;
    for (const horizonMs of [5_000, 20_000, 60_000]) {
      const window = trades.filter((t) => t.eventTime >= asOf - horizonMs);
      if (window.length < this.config.minTradesPerWindow) return reject('RECENT_FLOW_INSUFFICIENT');
      const total = window.reduce((sum, t) => sum + t.quantity, 0);
      const net = window.reduce((sum, t) => sum + (t.isBuyerMaker ? -t.quantity : t.quantity), 0);
      const signedFlowRatio = (sign * net) / total;
      const signedPriceResponseBps =
        ((sign * (window[window.length - 1].price - window[0].price)) / window[0].price) * 10_000;
      windows.push({
        horizonMs,
        tradeCount: window.length,
        signedFlowRatio,
        signedPriceResponseBps,
      });
      if (![signedFlowRatio, signedPriceResponseBps].every(Number.isFinite))
        return reject('RECENT_FLOW_INVALID');
      if (signedFlowRatio < this.config.minSignedFlowRatio)
        return reject('RECENT_FLOW_NOT_ALIGNED');
      if (signedPriceResponseBps < this.config.minSignedPriceResponseBps)
        return reject('PRICE_NOT_RESPONDING');
    }
    const key = `${evidence.sessionManifestSha256}:${side}:${episodeId}:${setup}`;
    const previous = this.states.get(symbol);
    if (previous && (now <= previous.lastAtMs || asOf <= previous.lastExchangeMs))
      return reject('NON_MONOTONIC_OBSERVATION');
    if (
      !previous ||
      previous.key !== key ||
      now - previous.lastAtMs > this.config.maxObservationGapMs ||
      asOf - previous.lastExchangeMs > this.config.maxObservationGapMs
    ) {
      this.states.set(symbol, {
        key,
        startedAtMs: now,
        lastAtMs: now,
        lastExchangeMs: asOf,
        lastTradeId: latest.aggregateTradeId,
      });
      return result('WAIT', 'PERSISTENCE_STARTED');
    }
    if (latest.aggregateTradeId <= previous.lastTradeId) return reject('NO_NEW_TRADE_EVIDENCE');
    this.states.set(symbol, {
      ...previous,
      lastAtMs: now,
      lastExchangeMs: asOf,
      lastTradeId: latest.aggregateTradeId,
    });
    return now - previous.startedAtMs >= this.config.persistenceMs
      ? result('QUALIFIED', 'CONTINUATION_FLOW_PRICE_PERSISTED')
      : result('WAIT', 'PERSISTENCE_PENDING');
  }

  reset(): void {
    this.states.clear();
  }
}
