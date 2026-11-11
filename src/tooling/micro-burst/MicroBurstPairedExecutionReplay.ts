import { MicroBurstExitEngine } from '../../strategies/micro-burst/domain/MicroBurstExitPolicy';
import type {
  MicroBurstConfig,
  MicroBurstExitContext,
} from '../../strategies/micro-burst/domain/MicroBurstTypes';
import {
  isVerifiedPullbackObservation,
  type PullbackObservation,
} from './MicroBurstPullbackCandidate';
import { depthVwap } from './MicroBurstCausalArchive';
import {
  assertVerifiedExecutionBook,
  isVerifiedFundingEvidence,
  assertVerifiedIntervalCoverage,
  type VerifiedExecutionBook,
  type VerifiedFundingEvidence,
  type VerifiedIntervalCoverage,
} from './MicroBurstCaptureSession';
import { createHash } from 'node:crypto';

export interface ExecutionAudit {
  decisionAtMs: number;
  earliestExecutionAtMs: number;
  executedAtMs: number;
  quantity: number;
  rawDepthVwap: number;
  modeledFillPrice: number;
  feeUsdt: number;
  additionalSlippageBps: number;
  bookSha256: string;
  consumedSide: 'BIDS' | 'ASKS';
  depth: { price: number; qty: number }[];
  bookTimestampEvidence: 'VERIFIED_ARCHIVE_CHECKPOINT_AND_RECEIVE_TIME';
  sessionManifestSha256: string;
  intervalCoverageSha256: string;
  fundingEvidenceSha256: string;
  fundingCashflowUsdt: number;
}

export interface PairedReplayFrame {
  atMs: number;
  observation: PullbackObservation;
  /** In-process archive certificates; raw booleans are not accepted as proof. */
  intervalCoverage: VerifiedIntervalCoverage | null;
  book: VerifiedExecutionBook | null;
  exitEvidence: Pick<
    MicroBurstExitContext,
    'currentBookPressure' | 'currentBtcContext' | 'marketEvidence'
  >;
}

export interface PairedReplayOptions {
  riskBudgetUsdt: number;
  maxNotionalUsdt: number;
  quantityStep: number;
  minNotionalUsdt: number;
  feeBpsPerSide: number;
  adverseSlippageBps: number;
  entryDelayMs: number;
  exitDelayMs: number;
  maxFrameGapMs: number;
  /** Null or missing historical coverage causes would-be fills to remain UNKNOWN. */
  fundingEvidence: VerifiedFundingEvidence | null;
}

export interface EpisodeExecution {
  executionKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL';
  variant: 'CURRENT' | 'PULLBACK';
  episodeId: string;
  side: 'LONG' | 'SHORT';
  signalAtMs: number;
  status: 'PENDING' | 'OPEN' | 'CLOSED' | 'UNFILLED' | 'UNKNOWN';
  entryAtMs?: number;
  entryPrice?: number;
  quantity?: number;
  exitAtMs?: number;
  exitPrice?: number;
  netPnlUsdt?: number;
  fundingCashflowUsdt?: number;
  entryAudit?: ExecutionAudit;
  exitAudit?: ExecutionAudit;
  riskBudgetUsdt?: number;
  protectionAssumption?: 'IMMEDIATE_STOP_COVERAGE_NOT_EXCHANGE_VALIDATED';
  reason?: string;
}

/** Paired, independent exit-engine state. Conservative data exclusion, never forced horizon PnL.
 * Observation qualification is selection only; entry uses a later frame and quantity-covered VWAP.
 * This model assumes immediate covering stops; it does not certify exchange protection latency.
 */
export function replayPairedExecutions(
  frames: readonly PairedReplayFrame[],
  config: MicroBurstConfig,
  options: PairedReplayOptions,
): EpisodeExecution[] {
  const { fundingEvidence, ...numbers } = options;
  if (
    (fundingEvidence !== null && !isVerifiedFundingEvidence(fundingEvidence)) ||
    !Object.values(numbers).every(Number.isFinite) ||
    options.riskBudgetUsdt <= 0 ||
    options.maxNotionalUsdt <= 0 ||
    options.quantityStep <= 0 ||
    options.minNotionalUsdt < 0 ||
    options.feeBpsPerSide < 0 ||
    options.adverseSlippageBps < 0 ||
    options.adverseSlippageBps >= 10_000 ||
    options.entryDelayMs < 0 ||
    options.exitDelayMs < 0 ||
    options.maxFrameGapMs <= 0
  )
    throw new Error('INVALID_REPLAY_OPTIONS');
  const results: EpisodeExecution[] = [];
  const audit = (
    decisionAtMs: number,
    delay: number,
    executedAtMs: number,
    quantity: number,
    rawDepthVwap: number,
    modeledFillPrice: number,
    consumedSide: 'BIDS' | 'ASKS',
    depth: readonly { price: number; qty: number }[],
    intervalCoverage: VerifiedIntervalCoverage,
    fundingEvidence: VerifiedFundingEvidence,
    fundingCashflowUsdt: number,
  ): ExecutionAudit => ({
    decisionAtMs,
    earliestExecutionAtMs: decisionAtMs + delay,
    executedAtMs,
    quantity,
    rawDepthVwap,
    modeledFillPrice,
    feeUsdt: (quantity * modeledFillPrice * options.feeBpsPerSide) / 10_000,
    additionalSlippageBps: options.adverseSlippageBps,
    bookSha256: createHash('sha256').update(JSON.stringify(depth)).digest('hex'),
    consumedSide,
    depth: depth.map((level) => ({ ...level })),
    bookTimestampEvidence: 'VERIFIED_ARCHIVE_CHECKPOINT_AND_RECEIVE_TIME',
    sessionManifestSha256: intervalCoverage.sessionManifestSha256,
    intervalCoverageSha256: intervalCoverage.evidenceSha256,
    fundingEvidenceSha256: fundingEvidence.evidenceSha256,
    fundingCashflowUsdt,
  });
  for (const variant of ['CURRENT', 'PULLBACK'] as const) {
    const engine = new MicroBurstExitEngine();
    const seen = new Set<string>();
    let active:
      | {
          result: EpisodeExecution;
          stop: number;
          target: number;
          initialStop: number;
          peak: number;
          trough: number;
          closeAt?: number;
        }
      | undefined;
    let previous = -Infinity;
    let symbol: string | undefined;
    for (const frame of frames) {
      if (
        !Number.isFinite(frame.atMs) ||
        frame.atMs <= previous ||
        frame.observation.observedAtMs !== frame.atMs
      )
        throw new Error('UNORDERED_OR_MISMATCHED_REPLAY_FRAME');
      if (!isVerifiedPullbackObservation(frame.observation))
        throw new Error('REPLAY_OBSERVATION_NOT_CAPTURE_VERIFIED');
      if (frame.book) assertVerifiedExecutionBook(frame.book);
      if (frame.intervalCoverage) assertVerifiedIntervalCoverage(frame.intervalCoverage);
      if (symbol && symbol !== frame.observation.symbol) throw new Error('ONE_SYMBOL_PER_REPLAY');
      symbol = frame.observation.symbol;
      const gap = frame.atMs - previous > options.maxFrameGapMs && previous !== -Infinity;
      const previousAtMs = previous;
      previous = frame.atMs;
      if (frame.book) {
        const { bidDepth, askDepth } = frame.book;
        for (const [levels, direction] of [
          [bidDepth, -1],
          [askDepth, 1],
        ] as const) {
          if (
            levels.some(
              (level, i) =>
                !Number.isFinite(level.price) ||
                level.price <= 0 ||
                !Number.isFinite(level.qty) ||
                level.qty < 0 ||
                (i > 0 && direction * (level.price - levels[i - 1].price) <= 0),
            )
          )
            throw new Error('INVALID_EXECUTION_DEPTH');
        }
        if (bidDepth.length && askDepth.length && bidDepth[0].price > askDepth[0].price)
          throw new Error('CROSSED_EXECUTION_DEPTH');
      }
      const coverageMatchesFrame = Boolean(
        frame.intervalCoverage &&
          frame.intervalCoverage.decisionId === frame.observation.sourceDecisionId &&
          frame.intervalCoverage.symbol === frame.observation.symbol &&
          frame.intervalCoverage.throughMs === frame.atMs &&
          frame.intervalCoverage.fromMs <=
            (previousAtMs === -Infinity ? frame.atMs : previousAtMs) &&
          frame.intervalCoverage.sessionManifestSha256 === frame.observation.sessionManifestSha256,
      );
      if (
        frame.book &&
        (frame.book.decisionId !== frame.observation.sourceDecisionId ||
          frame.book.symbol !== frame.observation.symbol ||
          frame.book.observedAtMs > frame.atMs ||
          frame.book.sessionManifestSha256 !== frame.observation.sessionManifestSha256 ||
          frame.intervalCoverage?.sessionManifestSha256 !== frame.book.sessionManifestSha256)
      )
        throw new Error('REPLAY_BOOK_FRAME_IDENTITY_OR_CLOCK_MISMATCH');
      if (!coverageMatchesFrame || gap || !frame.book) {
        if (active) {
          active.result.status = 'UNKNOWN';
          active.result.reason = gap
            ? 'FRAME_CADENCE_GAP'
            : !coverageMatchesFrame
              ? 'ARCHIVE_COVERAGE_UNVERIFIED'
              : 'EXECUTION_BOOK_UNAVAILABLE';
          active = undefined;
        }
        continue;
      }
      const baseline = frame.observation.baseline;
      const id = baseline.diagnostics.episodeId;
      if (
        !active &&
        baseline.action === 'ENTRY_INTENT' &&
        baseline.side &&
        typeof id === 'string' &&
        !seen.has(id) &&
        (variant === 'CURRENT' || frame.observation.candidate === 'QUALIFIED')
      ) {
        seen.add(id);
        const stop = baseline.stopInvalidationPrice,
          target = baseline.targetPrice;
        if (
          typeof stop !== 'number' ||
          typeof target !== 'number' ||
          ![stop, target].every((p) => Number.isFinite(p) && p > 0)
        )
          continue;
        const result: EpisodeExecution = {
          executionKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL',
          variant,
          episodeId: id,
          side: baseline.side,
          signalAtMs: frame.atMs,
          status: 'PENDING',
        };
        results.push(result);
        active = { result, stop, target, initialStop: stop, peak: 0, trough: Infinity };
      }
      if (!active) continue;
      const r = active.result;
      const sign = r.side === 'LONG' ? 1 : -1;
      const entryLevels = r.side === 'LONG' ? frame.book.askDepth : frame.book.bidDepth;
      const exitLevels = r.side === 'LONG' ? frame.book.bidDepth : frame.book.askDepth;
      const slip = options.adverseSlippageBps / 10_000;
      const fee = options.feeBpsPerSide / 10_000;
      if (r.status === 'PENDING') {
        if (frame.atMs < r.signalAtMs + options.entryDelayMs) continue;
        if (
          baseline.action !== 'ENTRY_INTENT' ||
          baseline.side !== r.side ||
          baseline.diagnostics.episodeId !== r.episodeId ||
          baseline.stopInvalidationPrice !== active.initialStop ||
          baseline.targetPrice !== active.target ||
          (variant === 'PULLBACK' && frame.observation.candidate !== 'QUALIFIED')
        ) {
          r.status = 'UNFILLED';
          r.reason = 'SIGNAL_NO_LONGER_CURRENT';
          active = undefined;
          continue;
        }
        const best = entryLevels[0]?.price;
        const exitBest = exitLevels[0]?.price;
        if (!Number.isFinite(exitBest) || sign * (exitBest - active.stop) <= 0) {
          r.status = 'UNFILLED';
          r.reason = 'STOP_ALREADY_INVALIDATED';
          active = undefined;
          continue;
        }
        let low = 0,
          high = Math.floor(options.maxNotionalUsdt / best / options.quantityStep);
        if (!Number.isSafeInteger(high) || high < 1) {
          r.status = 'UNFILLED';
          active = undefined;
          continue;
        }
        const fits = (steps: number): boolean => {
          const q = steps * options.quantityStep;
          const raw = depthVwap(entryLevels, q);
          if (raw === null) return false;
          const price = raw * (1 + sign * slip);
          const stressedStop = active!.stop * (1 - sign * slip);
          const loss = q * (sign * (price - stressedStop) + fee * (price + stressedStop));
          const costs = Math.max(
            config.exitEstimatedRoundTripCostBps,
            2 * options.feeBpsPerSide + options.adverseSlippageBps,
          );
          const room = ((sign * (active!.target - price)) / price) * 10_000 - costs;
          const risk = ((sign * (price - active!.stop)) / price) * 10_000 + costs;
          return (
            sign * (price - active!.stop) > 0 &&
            room >= config.minRoomBps &&
            room / risk >= config.minRewardRisk &&
            q * price <= options.maxNotionalUsdt &&
            loss > 0 &&
            loss <= options.riskBudgetUsdt
          );
        };
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (fits(mid)) low = mid;
          else high = mid - 1;
        }
        if (!low) {
          r.status = 'UNFILLED';
          r.reason = 'DEPTH_RISK_OR_NET_ROOM';
          active = undefined;
          continue;
        }
        r.quantity = low * options.quantityStep;
        r.entryPrice = depthVwap(entryLevels, r.quantity)! * (1 + sign * slip);
        if (r.entryPrice * r.quantity < options.minNotionalUsdt) {
          r.status = 'UNFILLED';
          active = undefined;
          continue;
        }
        const funding = options.fundingEvidence;
        if (
          !funding ||
          funding.symbol !== frame.observation.symbol ||
          funding.fromMs > r.signalAtMs ||
          funding.throughMs < frames[frames.length - 1].atMs
        ) {
          r.status = 'UNKNOWN';
          r.reason = 'FUNDING_EVIDENCE_UNAVAILABLE_OR_OUTSIDE_REPLAY_WINDOW';
          active = undefined;
          continue;
        }
        r.entryAtMs = frame.atMs;
        r.entryAudit = audit(
          r.signalAtMs,
          options.entryDelayMs,
          frame.atMs,
          r.quantity,
          depthVwap(entryLevels, r.quantity)!,
          r.entryPrice,
          r.side === 'LONG' ? 'ASKS' : 'BIDS',
          entryLevels,
          frame.intervalCoverage!,
          funding,
          0,
        );
        r.riskBudgetUsdt = options.riskBudgetUsdt;
        r.protectionAssumption = 'IMMEDIATE_STOP_COVERAGE_NOT_EXCHANGE_VALIDATED';
        r.status = 'OPEN';
        active.peak = r.entryPrice;
        active.trough = r.entryPrice;
      }
      const quote = depthVwap(exitLevels, r.quantity!);
      if (quote === null) {
        r.status = 'UNKNOWN';
        r.reason = 'EXIT_DEPTH_MISSING';
        active = undefined;
        continue;
      }
      active.peak = Math.max(active.peak, quote);
      active.trough = Math.min(active.trough, quote);
      if (active.closeAt === undefined) {
        if (sign * (quote - active.stop) <= 0) {
          active.closeAt = frame.atMs + options.exitDelayMs;
          r.reason = 'STOP_TOUCHED';
        } else {
          const decision = engine.evaluate(
            `${variant}:${r.episodeId}`,
            {
              ...frame.exitEvidence,
              currentPrice: quote,
              entryPrice: r.entryPrice!,
              peakPrice: active.peak,
              troughPrice: active.trough,
              priceReturn: (sign * (quote - r.entryPrice!)) / r.entryPrice!,
              unrealizedRoe: (sign * (quote - r.entryPrice!)) / r.entryPrice!,
              structuralInvalidationPrice: active.initialStop,
              destinationPrice: active.target,
              currentStopPrice: active.stop,
              timeInTradeMs: frame.atMs - r.entryAtMs!,
              observedAtMs: frame.atMs,
              momentumDecayFlag: false,
              anomalyExitFlag: false,
              leverage: 1,
            },
            config,
            r.side,
          );
          if (decision.action === 'MOVE_STOP' && decision.requestedStopPrice !== undefined)
            active.stop = decision.requestedStopPrice;
          if (decision.action === 'CLOSE_MARKET') {
            active.closeAt = frame.atMs + options.exitDelayMs;
            r.reason = decision.reason;
          }
        }
      }
      if (active.closeAt !== undefined && frame.atMs >= active.closeAt) {
        r.exitAtMs = frame.atMs;
        r.exitPrice = quote * (1 - sign * slip);
        const funding = options.fundingEvidence!;
        const fundingCashflowUsdt = funding.events
          .filter((event) => event.eventAtMs >= r.entryAtMs! && event.eventAtMs <= r.exitAtMs!)
          .reduce(
            (sum, event) => sum - sign * event.fundingRate * event.markPrice * r.quantity!,
            0,
          );
        r.fundingCashflowUsdt = fundingCashflowUsdt;
        r.exitAudit = audit(
          active.closeAt - options.exitDelayMs,
          options.exitDelayMs,
          frame.atMs,
          r.quantity!,
          quote,
          r.exitPrice,
          r.side === 'LONG' ? 'BIDS' : 'ASKS',
          exitLevels,
          frame.intervalCoverage!,
          funding,
          fundingCashflowUsdt,
        );
        r.netPnlUsdt =
          r.quantity! *
            (sign * (r.exitPrice - r.entryPrice!) - fee * (r.entryPrice! + r.exitPrice)) +
          fundingCashflowUsdt;
        r.status = 'CLOSED';
        active = undefined;
      }
    }
    if (active) {
      active.result.status = 'UNKNOWN';
      active.result.reason = 'END_OF_COVERAGE';
    }
  }
  return results;
}
