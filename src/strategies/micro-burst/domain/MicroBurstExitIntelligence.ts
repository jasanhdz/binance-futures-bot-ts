import { MicroBurstConfig, MicroBurstExitContext } from './MicroBurstTypes';
import { decimalReturnToBps } from './MicroBurstUnits';

export type MicroBurstExitStage = 'PROVING' | 'RUNNING' | 'PROTECTING' | 'EXHAUSTED';

export type MicroBurstExitEvidenceSource = 'PRICE' | 'FLOW' | 'BOOK' | 'BTC' | 'STRUCTURE_TIME';

export type MicroBurstSourceDisposition = 'SUPPORTIVE' | 'NEUTRAL' | 'ADVERSE' | 'UNAVAILABLE';

export interface MicroBurstExitBaseline {
  readonly observedAtMs: number;
  readonly sideAwareFlowRatio: number | null;
  readonly sideAwareBookPressure: number | null;
}

export interface MicroBurstExitSourceAssessment {
  readonly source: MicroBurstExitEvidenceSource;
  readonly disposition: MicroBurstSourceDisposition;
  /** Direction-free confidence in the disposition, normalized to [0, 1]. */
  readonly strength: number;
  /** Legacy-compatible evidence contribution. Sources, not sub-signals, are counted. */
  readonly evidenceScore: number;
  readonly reversalFromBaseline: boolean | null;
  readonly diagnostics: Record<string, unknown>;
}

export interface MicroBurstContinuationAssessment {
  readonly stage: MicroBurstExitStage;
  readonly grossReturnBps: number;
  readonly estimatedNetReturnBps: number;
  readonly maxFavorableExcursionBps: number;
  readonly maxAdverseExcursionBps: number;
  readonly structuralProgress: number;
  readonly remainingRoomBps: number;
  readonly entryRiskBps: number;
  readonly continuationSupport: number;
  readonly exitPressure: number;
  readonly adverseSources: MicroBurstExitEvidenceSource[];
  readonly supportiveSources: MicroBurstExitEvidenceSource[];
  readonly availableSources: MicroBurstExitEvidenceSource[];
  readonly evidenceScore: number;
  readonly fastAdverseSource: boolean;
  readonly continuationEligible: boolean;
  readonly sources: MicroBurstExitSourceAssessment[];
}

const SOURCE_WEIGHTS: Readonly<Record<MicroBurstExitEvidenceSource, number>> = {
  PRICE: 0.35,
  FLOW: 0.25,
  BOOK: 0.15,
  BTC: 0.15,
  STRUCTURE_TIME: 0.1,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sideAware(value: number, side: 'LONG' | 'SHORT'): number {
  return side === 'LONG' ? value : -value;
}

function currentReturnBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const rawReturn = (context.currentPrice - context.entryPrice) / context.entryPrice;
  return decimalReturnToBps(sideAware(rawReturn, side));
}

function favorableExcursionBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const rawReturn =
    side === 'LONG'
      ? (context.peakPrice - context.entryPrice) / context.entryPrice
      : (context.entryPrice - context.troughPrice) / context.entryPrice;
  return Math.max(0, decimalReturnToBps(rawReturn));
}

function adverseExcursionBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const rawReturn =
    side === 'LONG'
      ? (context.entryPrice - context.troughPrice) / context.entryPrice
      : (context.peakPrice - context.entryPrice) / context.entryPrice;
  return Math.max(0, decimalReturnToBps(rawReturn));
}

function structuralProgress(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const path = sideAware(context.destinationPrice - context.entryPrice, side);
  if (!Number.isFinite(path) || path <= 0) return 0;
  return sideAware(context.currentPrice - context.entryPrice, side) / path;
}

function remainingRoomBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const rawReturn = (context.destinationPrice - context.currentPrice) / context.entryPrice;
  return decimalReturnToBps(sideAware(rawReturn, side));
}

function entryRiskBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const rawRisk = sideAware(context.entryPrice - context.structuralInvalidationPrice, side);
  return Math.max(0, decimalReturnToBps(rawRisk / context.entryPrice));
}

function observationTime(context: MicroBurstExitContext): number {
  return Number.isFinite(context.observedAtMs)
    ? (context.observedAtMs as number)
    : Math.max(0, context.timeInTradeMs);
}

function freshMarketEvidence(context: MicroBurstExitContext, config: MicroBurstConfig) {
  const market = context.marketEvidence;
  if (!market) return null;
  const ageMs = observationTime(context) - market.observedAtMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= config.exitIntelligenceMaxObservationGapMs
    ? market
    : null;
}

function flowRatio(buyVolume: number, sellVolume: number): number {
  const total = buyVolume + sellVolume;
  return total > 0 ? (buyVolume - sellVolume) / total : 0;
}

function unavailable(
  source: MicroBurstExitEvidenceSource,
  diagnostics: Record<string, unknown>,
): MicroBurstExitSourceAssessment {
  return {
    source,
    disposition: 'UNAVAILABLE',
    strength: 0,
    evidenceScore: 0,
    reversalFromBaseline: null,
    diagnostics,
  };
}

function neutral(
  source: MicroBurstExitEvidenceSource,
  diagnostics: Record<string, unknown>,
): MicroBurstExitSourceAssessment {
  return {
    source,
    disposition: 'NEUTRAL',
    strength: 0,
    evidenceScore: 0,
    reversalFromBaseline: null,
    diagnostics,
  };
}

export function captureMicroBurstExitBaseline(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitBaseline {
  const market = freshMarketEvidence(context, config);
  const flowAvailable = Boolean(
    market?.takerFlowWindowComplete &&
      market.takerFlowGapFree &&
      market.takerTradeCount >= config.exitFlowMinTrades,
  );
  const book = context.currentBookPressure;
  return {
    observedAtMs: observationTime(context),
    sideAwareFlowRatio:
      market && flowAvailable
        ? sideAware(flowRatio(market.buyTakerVolume, market.sellTakerVolume), side)
        : null,
    sideAwareBookPressure:
      book?.status === 'HEALTHY' ? sideAware(book.signedTopOfBookImbalance, side) : null,
  };
}

function assessPrice(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitSourceAssessment {
  const market = freshMarketEvidence(context, config);
  const shortReturn = market?.shortHorizonReturnBps;
  if (
    !market ||
    market.priceSampleCount < 2 ||
    typeof shortReturn !== 'number' ||
    !Number.isFinite(shortReturn)
  ) {
    if (context.momentumDecayFlag) {
      return {
        source: 'PRICE',
        disposition: 'ADVERSE',
        strength: 1,
        evidenceScore: 2,
        reversalFromBaseline: null,
        diagnostics: { explicitMomentumDecay: true, marketEvidenceAvailable: false },
      };
    }
    return unavailable('PRICE', { reason: 'FRESH_PRICE_WINDOW_UNAVAILABLE' });
  }
  const sideAwareShort = sideAware(shortReturn, side);
  const mediumReturn = market.mediumHorizonReturnBps;
  const sideAwareMedium =
    typeof mediumReturn === 'number' && Number.isFinite(mediumReturn)
      ? sideAware(mediumReturn, side)
      : null;
  const threshold = Math.max(Number.EPSILON, config.exitMomentumReversalBps);
  const diagnostics = {
    shortHorizonReturnBps: shortReturn,
    mediumHorizonReturnBps: mediumReturn,
    sideAwareShortReturnBps: sideAwareShort,
    sideAwareMediumReturnBps: sideAwareMedium,
    explicitMomentumDecay: context.momentumDecayFlag,
  };
  if (context.momentumDecayFlag || sideAwareShort <= -threshold) {
    return {
      source: 'PRICE',
      disposition: 'ADVERSE',
      strength: context.momentumDecayFlag
        ? 1
        : clamp(Math.abs(sideAwareShort) / (threshold * 3), 0.34, 1),
      evidenceScore: 2,
      reversalFromBaseline: null,
      diagnostics,
    };
  }
  if (sideAwareShort >= threshold && (sideAwareMedium === null || sideAwareMedium >= -threshold)) {
    return {
      source: 'PRICE',
      disposition: 'SUPPORTIVE',
      strength: clamp(sideAwareShort / (threshold * 3), 0.34, 1),
      evidenceScore: 0,
      reversalFromBaseline: null,
      diagnostics,
    };
  }
  return neutral('PRICE', diagnostics);
}

function assessFlow(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
  baseline: MicroBurstExitBaseline | null,
): MicroBurstExitSourceAssessment {
  const market = freshMarketEvidence(context, config);
  if (
    !market ||
    !market.takerFlowWindowComplete ||
    !market.takerFlowGapFree ||
    market.takerTradeCount < config.exitFlowMinTrades
  ) {
    return unavailable('FLOW', { reason: 'QUALIFIED_TAKER_FLOW_UNAVAILABLE' });
  }
  const rawRatio = flowRatio(market.buyTakerVolume, market.sellTakerVolume);
  const directionalRatio = sideAware(rawRatio, side);
  const threshold = Math.max(Number.EPSILON, config.exitFlowReversalRatio);
  const reversalFromBaseline =
    baseline?.sideAwareFlowRatio === null || baseline?.sideAwareFlowRatio === undefined
      ? null
      : baseline.sideAwareFlowRatio >= 0 && directionalRatio < 0;
  const diagnostics = {
    rawFlowRatio: rawRatio,
    sideAwareFlowRatio: directionalRatio,
    tradeCount: market.takerTradeCount,
    baselineSideAwareFlowRatio: baseline?.sideAwareFlowRatio ?? null,
  };
  if (directionalRatio <= -threshold) {
    return {
      source: 'FLOW',
      disposition: 'ADVERSE',
      strength: clamp(Math.abs(directionalRatio) / (threshold * 3), 0.34, 1),
      evidenceScore: 2,
      reversalFromBaseline,
      diagnostics,
    };
  }
  if (directionalRatio >= threshold) {
    return {
      source: 'FLOW',
      disposition: 'SUPPORTIVE',
      strength: clamp(directionalRatio / (threshold * 3), 0.34, 1),
      evidenceScore: 0,
      reversalFromBaseline: false,
      diagnostics,
    };
  }
  return neutral('FLOW', diagnostics);
}

function assessBook(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
  baseline: MicroBurstExitBaseline | null,
): MicroBurstExitSourceAssessment {
  const book = context.currentBookPressure;
  if (!book || book.status !== 'HEALTHY') {
    return unavailable('BOOK', { status: book?.status ?? 'UNAVAILABLE' });
  }
  const pressure = sideAware(book.signedTopOfBookImbalance, side);
  const slope = book.imbalanceSlope === null ? null : sideAware(book.imbalanceSlope, side);
  const pressureAdverse = pressure <= -config.exitBookReversalImbalance;
  const slopeAdverse = slope !== null && slope <= -config.exitBookReversalSlope;
  const microstructureAdverse =
    pressure <= 0 && (book.temporalAbsorptionDetected || book.temporalSweepDetected);
  const pressureSupportive = pressure >= config.exitBookReversalImbalance;
  const slopeSupportive = slope === null || slope >= -config.exitBookReversalSlope;
  const reversalFromBaseline =
    baseline?.sideAwareBookPressure === null || baseline?.sideAwareBookPressure === undefined
      ? null
      : baseline.sideAwareBookPressure >= 0 && pressure < 0;
  const diagnostics = {
    sideAwareBookPressure: pressure,
    sideAwareBookSlope: slope,
    temporalAbsorptionDetected: book.temporalAbsorptionDetected,
    temporalSweepDetected: book.temporalSweepDetected,
    baselineSideAwareBookPressure: baseline?.sideAwareBookPressure ?? null,
    correlatedSubsignalsCount: [
      pressureAdverse,
      slopeAdverse,
      book.temporalAbsorptionDetected,
      book.temporalSweepDetected,
    ].filter(Boolean).length,
  };
  if (pressureAdverse || slopeAdverse || microstructureAdverse) {
    const pressureStrength =
      Math.abs(Math.min(0, pressure)) /
      Math.max(config.exitBookReversalImbalance * 3, Number.EPSILON);
    const slopeStrength =
      slope === null
        ? 0
        : Math.abs(Math.min(0, slope)) / Math.max(config.exitBookReversalSlope * 3, Number.EPSILON);
    return {
      source: 'BOOK',
      disposition: 'ADVERSE',
      strength: clamp(
        Math.max(pressureStrength, slopeStrength, microstructureAdverse ? 0.5 : 0),
        0.34,
        1,
      ),
      evidenceScore: pressureAdverse || book.temporalSweepDetected ? 2 : 1,
      reversalFromBaseline,
      diagnostics,
    };
  }
  if (pressureSupportive && slopeSupportive) {
    return {
      source: 'BOOK',
      disposition: 'SUPPORTIVE',
      strength: clamp(
        pressure / Math.max(config.exitBookReversalImbalance * 3, Number.EPSILON),
        0.34,
        1,
      ),
      evidenceScore: 0,
      reversalFromBaseline: false,
      diagnostics,
    };
  }
  return neutral('BOOK', diagnostics);
}

function assessBtc(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitSourceAssessment {
  const btc = context.currentBtcContext;
  if (!btc) return unavailable('BTC', { reason: 'BTC_CONTEXT_UNAVAILABLE' });
  const ageMs = observationTime(context) - btc.observedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > config.btcFreshnessMaxMs)
    return unavailable('BTC', { reason: 'FRESH_BTC_CONTEXT_UNAVAILABLE', ageMs });
  const directionalRet3mBps = sideAware(decimalReturnToBps(btc.ret3m), side);
  const threshold = Math.max(Number.EPSILON, config.btcConflictThresholdBps);
  const directionConflicts =
    (side === 'LONG' && btc.direction === 'SHORT') ||
    (side === 'SHORT' && btc.direction === 'LONG');
  const directionSupports = btc.direction === side;
  const diagnostics = {
    conflictFlag: btc.conflictFlag,
    btcDirection: btc.direction,
    directionalRet3mBps,
    directionConflicts,
    ageMs,
  };
  if (btc.conflictFlag || directionalRet3mBps <= -threshold) {
    return {
      source: 'BTC',
      disposition: 'ADVERSE',
      strength: btc.conflictFlag
        ? 1
        : clamp(Math.abs(directionalRet3mBps) / (threshold * 2), 0.5, 1),
      evidenceScore: 2,
      reversalFromBaseline: null,
      diagnostics,
    };
  }
  if (directionSupports && directionalRet3mBps >= threshold * 0.5) {
    return {
      source: 'BTC',
      disposition: 'SUPPORTIVE',
      strength: clamp(directionalRet3mBps / (threshold * 2), 0.25, 1),
      evidenceScore: 0,
      reversalFromBaseline: false,
      diagnostics,
    };
  }
  return neutral('BTC', diagnostics);
}

function assessStructureTime(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  grossReturnBps: number,
  progress: number,
  fastSources: MicroBurstExitSourceAssessment[],
): MicroBurstExitSourceAssessment {
  const timeRatio = context.timeInTradeMs / Math.max(1, config.exitMaxHoldMs);
  const fastSupportive = fastSources.some((source) => source.disposition === 'SUPPORTIVE');
  const exhaustedWithoutFastSupport =
    progress >= config.exitStructuralExhaustionProgress && !fastSupportive;
  const staleWithoutNetProfit =
    timeRatio >= 0.7 &&
    progress < config.exitStructuralExhaustionProgress &&
    grossReturnBps <= config.exitEstimatedRoundTripCostBps;
  const diagnostics = {
    timeRatio,
    structuralProgress: progress,
    exhaustedWithoutFastSupport,
    staleWithoutNetProfit,
  };
  if (exhaustedWithoutFastSupport || staleWithoutNetProfit) {
    return {
      source: 'STRUCTURE_TIME',
      disposition: 'ADVERSE',
      strength: clamp(Math.max(progress, timeRatio), 0.5, 1),
      evidenceScore: staleWithoutNetProfit ? 2 : 1,
      reversalFromBaseline: null,
      diagnostics,
    };
  }
  if (
    (progress >= 0.25 || grossReturnBps > config.exitEstimatedRoundTripCostBps) &&
    timeRatio < 1
  ) {
    return {
      source: 'STRUCTURE_TIME',
      disposition: 'SUPPORTIVE',
      strength: clamp(
        Math.max(progress, grossReturnBps / Math.max(1, config.exitEstimatedRoundTripCostBps * 3)),
        0.25,
        1,
      ),
      evidenceScore: 0,
      reversalFromBaseline: false,
      diagnostics,
    };
  }
  return neutral('STRUCTURE_TIME', diagnostics);
}

function protectedBeyondEntry(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): boolean {
  if (context.currentStopPrice === null || !Number.isFinite(context.currentStopPrice)) return false;
  return side === 'LONG'
    ? context.currentStopPrice > context.entryPrice
    : context.currentStopPrice < context.entryPrice;
}

export function assessMicroBurstContinuation(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
  baseline: MicroBurstExitBaseline | null = null,
): MicroBurstContinuationAssessment {
  const grossReturnBps = currentReturnBps(context, side);
  const progress = structuralProgress(context, side);
  const price = assessPrice(context, config, side);
  const flow = assessFlow(context, config, side, baseline);
  const book = assessBook(context, config, side, baseline);
  const btc = assessBtc(context, config, side);
  const structureTime = assessStructureTime(context, config, grossReturnBps, progress, [
    price,
    flow,
  ]);
  const sources = [price, flow, book, btc, structureTime];
  const directional = sources.filter(
    (source) => source.disposition === 'SUPPORTIVE' || source.disposition === 'ADVERSE',
  );
  const supportiveWeight = directional
    .filter((source) => source.disposition === 'SUPPORTIVE')
    .reduce((sum, source) => sum + SOURCE_WEIGHTS[source.source] * source.strength, 0);
  const adverseWeight = directional
    .filter((source) => source.disposition === 'ADVERSE')
    .reduce((sum, source) => sum + SOURCE_WEIGHTS[source.source] * source.strength, 0);
  const directionalWeight = supportiveWeight + adverseWeight;
  const continuationSupport = directionalWeight > 0 ? supportiveWeight / directionalWeight : 0.5;
  const exitPressure = directionalWeight > 0 ? adverseWeight / directionalWeight : 0.5;
  const adverseSources = sources
    .filter((source) => source.disposition === 'ADVERSE')
    .map((source) => source.source);
  const supportiveSources = sources
    .filter((source) => source.disposition === 'SUPPORTIVE')
    .map((source) => source.source);
  const availableSources = sources
    .filter((source) => source.disposition !== 'UNAVAILABLE')
    .map((source) => source.source);
  const fastSupportive = supportiveSources.some(
    (source) => source === 'PRICE' || source === 'FLOW',
  );
  const continuationEligible =
    availableSources.length >= 2 &&
    supportiveSources.length >= 2 &&
    fastSupportive &&
    !adverseSources.includes('PRICE') &&
    continuationSupport >= config.exitContinuationSupportThreshold;
  const maxFavorableExcursionBps = favorableExcursionBps(context, side);
  const exhausted =
    progress >= config.exitStructuralExhaustionProgress ||
    context.timeInTradeMs >= config.exitMaxHoldMs * 0.7;
  const stage: MicroBurstExitStage =
    context.timeInTradeMs < config.exitProofWindowMs &&
    maxFavorableExcursionBps < config.exitMinProofExcursionBps
      ? 'PROVING'
      : exhausted
        ? 'EXHAUSTED'
        : protectedBeyondEntry(context, side)
          ? 'PROTECTING'
          : 'RUNNING';

  return {
    stage,
    grossReturnBps,
    estimatedNetReturnBps: grossReturnBps - config.exitEstimatedRoundTripCostBps,
    maxFavorableExcursionBps,
    maxAdverseExcursionBps: adverseExcursionBps(context, side),
    structuralProgress: progress,
    remainingRoomBps: remainingRoomBps(context, side),
    entryRiskBps: entryRiskBps(context, side),
    continuationSupport,
    exitPressure,
    adverseSources,
    supportiveSources,
    availableSources,
    evidenceScore: sources.reduce((sum, source) => sum + source.evidenceScore, 0),
    fastAdverseSource: adverseSources.some((source) => source === 'PRICE' || source === 'FLOW'),
    continuationEligible,
    sources,
  };
}

export function microBurstContinuationDiagnostics(
  assessment: MicroBurstContinuationAssessment,
): Record<string, unknown> {
  return {
    exitPolicyVersion: 'EXPECTED_CONTINUATION_V2',
    exitStage: assessment.stage,
    grossReturnBps: assessment.grossReturnBps,
    estimatedNetReturnBps: assessment.estimatedNetReturnBps,
    maxFavorableExcursionBps: assessment.maxFavorableExcursionBps,
    maxAdverseExcursionBps: assessment.maxAdverseExcursionBps,
    structuralProgress: assessment.structuralProgress,
    remainingRoomBps: assessment.remainingRoomBps,
    entryRiskBps: assessment.entryRiskBps,
    continuationSupport: assessment.continuationSupport,
    exitPressure: assessment.exitPressure,
    adverseSources: assessment.adverseSources,
    supportiveSources: assessment.supportiveSources,
    availableSources: assessment.availableSources,
    evidenceScore: assessment.evidenceScore,
    continuationEligible: assessment.continuationEligible,
    sources: Object.fromEntries(
      assessment.sources.map((source) => [
        source.source,
        {
          disposition: source.disposition,
          strength: source.strength,
          evidenceScore: source.evidenceScore,
          reversalFromBaseline: source.reversalFromBaseline,
          ...source.diagnostics,
        },
      ]),
    ),
    noTrailingCallbackUsed: true,
  };
}
