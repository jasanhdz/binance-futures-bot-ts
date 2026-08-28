import { MicroBurstExitContext, MicroBurstExitDecision, MicroBurstConfig } from './MicroBurstTypes';
import { MicroBurstShadowEvaluationResult } from './MicroBurstMarketDataTypes';
import { evaluateMicroBurstExit } from './MicroBurstExitPolicy';
import { decimalReturnToBps } from './MicroBurstUnits';

export type MicroBurstPaperState =
  | 'FLAT'
  | 'OPEN_SHADOW'
  | 'MANAGING'
  | 'CLOSED'
  | 'DATA_UNCERTAIN'
  | 'RECOVERY_BLOCKED';

export type PaperEntryPriceModel = 'BEST_ASK' | 'BEST_BID';

export interface MicroBurstPaperQuote {
  bestBid: number;
  bestAsk: number;
  observedAtMs: number;
  status: 'HEALTHY' | 'STALE' | 'UNSYNCED' | 'UNAVAILABLE' | 'ANOMALOUS';
  spreadBps?: number;
}

export interface MicroBurstPaperObservation {
  currentPrice: number;
  observedAtMs: number;
  quote?: MicroBurstPaperQuote;
  exitContext?: Pick<
    MicroBurstExitContext,
    'currentBookPressure' | 'currentBtcContext' | 'anomalyExitFlag'
  >;
}

export interface MicroBurstPaperPosition {
  schemaVersion: 1;
  state: Exclude<MicroBurstPaperState, 'FLAT' | 'RECOVERY_BLOCKED'>;
  tradeId: string;
  parentSignalId: string;
  strategyId: 'MICRO_BURST_V1';
  strategyVersion: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  openedAtMs: number;
  entryDecisionPrice: number;
  entryExecutablePrice: number;
  entryPrice: number;
  entryPriceModel: PaperEntryPriceModel;
  leverage: number;
  positionFraction: number;
  initialStructuralStop: number;
  currentStop: number;
  destinationPrice: number;
  peakPrice: number;
  troughPrice: number;
  breakEvenArmed: boolean;
  trailingActivated: boolean;
  lastObservedAtMs: number;
  cohortId: string;
  codeCommitSha: string;
  configHash: string;
  spreadBps: number;
  slippageBps: number;
  closedAtMs?: number;
  decisionExitPrice?: number;
  executableExitPrice?: number;
  exitPrice?: number;
  exitReason?: string;
  finalStop?: number;
  grossPriceReturnBps?: number;
  grossRoe?: number;
  mfeBps?: number;
  maeBps?: number;
  feesBps?: number;
  spreadImpactBps?: number;
  otherCostsBps?: number;
  totalCostBps?: number;
  netBps?: number;
  netRoe?: number;
}

export type PaperLifecycleEventName =
  | 'OPENED'
  | 'UNFILLED_DATA_UNCERTAIN'
  | 'ENTRY_SUPPRESSED_POSITION_OPEN'
  | 'STOP_MOVED'
  | 'BREAK_EVEN_ARMED'
  | 'TRAILING_ACTIVATED'
  | 'TRAILING_MOVED'
  | 'DATA_UNCERTAIN'
  | 'RECOVERED_AFTER_RESTART'
  | 'CLOSED';

export interface MicroBurstPaperLifecycleEvent {
  schemaVersion: 1;
  event: PaperLifecycleEventName;
  eventAtMs: number;
  tradeId?: string;
  symbol: string;
  state: MicroBurstPaperState;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type PaperOpenResult =
  | { status: 'OPENED'; position: MicroBurstPaperPosition; event: MicroBurstPaperLifecycleEvent }
  | { status: 'SUPPRESSED'; event: MicroBurstPaperLifecycleEvent }
  | { status: 'UNFILLED_DATA_UNCERTAIN'; event: MicroBurstPaperLifecycleEvent };

export type PaperManageResult = {
  position: MicroBurstPaperPosition;
  events: MicroBurstPaperLifecycleEvent[];
  exitDecision: MicroBurstExitDecision | null;
};

export class MicroBurstPaperTrading {
  private readonly positions = new Map<string, MicroBurstPaperPosition>();

  constructor(private readonly config: MicroBurstConfig) {}

  restore(position: MicroBurstPaperPosition): void {
    if (position.state === 'CLOSED') return;
    if (this.positions.has(position.symbol))
      throw new Error(`PAPER_POSITION_AMBIGUOUS:${position.symbol}`);
    this.positions.set(position.symbol, { ...position, state: 'OPEN_SHADOW' });
  }

  getPosition(symbol: string): MicroBurstPaperPosition | undefined {
    const position = this.positions.get(symbol);
    return position ? { ...position } : undefined;
  }

  getOpenPositions(): MicroBurstPaperPosition[] {
    return [...this.positions.values()].map((position) => ({ ...position }));
  }

  open(
    signal: MicroBurstShadowEvaluationResult,
    quote: MicroBurstPaperQuote | undefined,
    eventAtMs: number,
    provenance: { cohortId: string; codeCommitSha: string; configHash: string },
  ): PaperOpenResult {
    const existing = this.positions.get(signal.symbol);
    if (existing) {
      return {
        status: 'SUPPRESSED',
        event: this.event(
          'ENTRY_SUPPRESSED_POSITION_OPEN',
          eventAtMs,
          signal.symbol,
          existing.tradeId,
          'OPEN_SHADOW',
        ),
      };
    }
    const fill = executableEntry(signal, quote);
    if (!fill) {
      return {
        status: 'UNFILLED_DATA_UNCERTAIN',
        event: this.event(
          'UNFILLED_DATA_UNCERTAIN',
          eventAtMs,
          signal.symbol,
          undefined,
          'DATA_UNCERTAIN',
        ),
      };
    }
    const tradeId = `PAPER-${signal.shadowSignalId}`;
    const position: MicroBurstPaperPosition = {
      schemaVersion: 1,
      state: 'OPEN_SHADOW',
      tradeId,
      parentSignalId: signal.shadowSignalId,
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: signal.strategyVersion,
      symbol: signal.symbol,
      side: signal.side!,
      openedAtMs: eventAtMs,
      entryDecisionPrice: signal.referencePrice,
      entryExecutablePrice: fill.price,
      entryPrice: fill.price,
      entryPriceModel: fill.model,
      leverage: numberDiagnostic(signal.diagnostics.leverage, 0),
      positionFraction: numberDiagnostic(signal.diagnostics.positionFraction, 0),
      initialStructuralStop: signal.structuralInvalidation!,
      currentStop: signal.structuralInvalidation!,
      destinationPrice: signal.destinationPrice!,
      peakPrice: fill.price,
      troughPrice: fill.price,
      breakEvenArmed: false,
      trailingActivated: false,
      lastObservedAtMs: eventAtMs,
      cohortId: provenance.cohortId,
      codeCommitSha: provenance.codeCommitSha,
      configHash: provenance.configHash,
      spreadBps:
        quote!.spreadBps ?? decimalReturnToBps((quote!.bestAsk - quote!.bestBid) / quote!.bestBid),
      slippageBps: 0,
    };
    this.positions.set(signal.symbol, position);
    return {
      status: 'OPENED',
      position: { ...position },
      event: this.event('OPENED', eventAtMs, signal.symbol, tradeId, 'OPEN_SHADOW'),
    };
  }

  manage(symbol: string, observation: MicroBurstPaperObservation): PaperManageResult | null {
    const current = this.positions.get(symbol);
    if (!current) return null;
    const position = { ...current };
    const events: MicroBurstPaperLifecycleEvent[] = [];
    position.lastObservedAtMs = observation.observedAtMs;
    position.peakPrice = Math.max(position.peakPrice, observation.currentPrice);
    position.troughPrice = Math.min(position.troughPrice, observation.currentPrice);
    position.state = 'MANAGING';

    const side = position.side;
    const stopTouched =
      side === 'LONG'
        ? observation.currentPrice <= position.currentStop
        : observation.currentPrice >= position.currentStop;
    let decision: MicroBurstExitDecision | null = null;
    if (stopTouched) {
      decision = {
        action: 'CLOSE_MARKET',
        reason: position.breakEvenArmed ? 'BREAK_EVEN' : 'HARD_INVALIDATION',
        diagnostics: { virtualStop: true },
      };
    } else {
      const context: MicroBurstExitContext = {
        unrealizedRoe: this.roe(position, observation.currentPrice),
        priceReturn: this.signedReturn(position, observation.currentPrice),
        currentPrice: observation.currentPrice,
        entryPrice: position.entryPrice,
        peakPrice: position.peakPrice,
        troughPrice: position.troughPrice,
        structuralInvalidationPrice: position.initialStructuralStop,
        destinationPrice: position.destinationPrice,
        currentStopPrice: position.currentStop,
        timeInTradeMs: Math.max(0, observation.observedAtMs - position.openedAtMs),
        momentumDecayFlag: false,
        anomalyExitFlag: observation.exitContext?.anomalyExitFlag ?? false,
        currentBookPressure: observation.exitContext?.currentBookPressure ?? null,
        currentBtcContext: observation.exitContext?.currentBtcContext ?? null,
        leverage: position.leverage,
      };
      decision = evaluateMicroBurstExit(context, this.config, side);
    }

    if (
      this.favorableBps(position) >= this.config.exitTrailingActivationBps &&
      !position.trailingActivated
    ) {
      position.trailingActivated = true;
      events.push(
        this.event(
          'TRAILING_ACTIVATED',
          observation.observedAtMs,
          symbol,
          position.tradeId,
          position.state,
        ),
      );
    }
    if (decision?.action === 'MOVE_STOP' && decision.requestedStopPrice !== undefined) {
      const next = tightenStop(side, position.currentStop, decision.requestedStopPrice);
      if (next !== position.currentStop) {
        const old = position.currentStop;
        position.currentStop = next;
        position.breakEvenArmed = next === position.entryPrice;
        events.push(
          this.event(
            position.breakEvenArmed ? 'BREAK_EVEN_ARMED' : 'STOP_MOVED',
            observation.observedAtMs,
            symbol,
            position.tradeId,
            position.state,
            undefined,
            { oldStop: old, newStop: next },
          ),
        );
      }
    }
    if (decision?.action === 'CLOSE_MARKET') {
      const exitPrice = executableExit(
        side,
        observation.quote && observation.quote.observedAtMs <= observation.observedAtMs
          ? observation.quote
          : undefined,
      );
      if (exitPrice === undefined) {
        position.state = 'DATA_UNCERTAIN';
        this.positions.set(symbol, position);
        events.push(
          this.event(
            'DATA_UNCERTAIN',
            observation.observedAtMs,
            symbol,
            position.tradeId,
            position.state,
            'EXIT_EXECUTABLE_PRICE_UNAVAILABLE',
          ),
        );
        return { position, events, exitDecision: decision };
      }
      position.closedAtMs = observation.observedAtMs;
      position.decisionExitPrice = observation.currentPrice;
      position.executableExitPrice = exitPrice;
      position.exitPrice = exitPrice;
      position.exitReason = decision.reason;
      position.finalStop = position.currentStop;
      position.mfeBps = this.favorableBps(position);
      position.maeBps = this.adverseBps(position);
      position.grossPriceReturnBps = decimalReturnToBps(this.signedReturn(position, exitPrice));
      position.grossRoe = (position.grossPriceReturnBps / 10_000) * position.leverage;
      position.feesBps = 0;
      position.spreadImpactBps = 0;
      position.slippageBps = 0;
      position.otherCostsBps = 0;
      position.totalCostBps = 0;
      position.netBps = position.grossPriceReturnBps;
      position.netRoe = position.grossRoe;
      position.state = 'CLOSED';
      this.positions.delete(symbol);
      events.push(
        this.event(
          'CLOSED',
          observation.observedAtMs,
          symbol,
          position.tradeId,
          position.state,
          decision.reason,
        ),
      );
    } else {
      this.positions.set(symbol, position);
    }
    return { position, events, exitDecision: decision };
  }

  private favorableBps(position: MicroBurstPaperPosition): number {
    return decimalReturnToBps(
      position.side === 'LONG'
        ? (position.peakPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - position.troughPrice) / position.entryPrice,
    );
  }

  private adverseBps(position: MicroBurstPaperPosition): number {
    return decimalReturnToBps(
      position.side === 'LONG'
        ? (position.entryPrice - position.troughPrice) / position.entryPrice
        : (position.peakPrice - position.entryPrice) / position.entryPrice,
    );
  }

  private signedReturn(position: MicroBurstPaperPosition, price: number): number {
    const raw = (price - position.entryPrice) / position.entryPrice;
    return position.side === 'LONG' ? raw : -raw;
  }

  private roe(position: MicroBurstPaperPosition, price: number): number {
    return this.signedReturn(position, price) * position.leverage;
  }

  private event(
    event: PaperLifecycleEventName,
    eventAtMs: number,
    symbol: string,
    tradeId: string | undefined,
    state: MicroBurstPaperState,
    reason?: string,
    metadata?: Record<string, unknown>,
  ): MicroBurstPaperLifecycleEvent {
    return { schemaVersion: 1, event, eventAtMs, tradeId, symbol, state, reason, metadata };
  }
}

function numberDiagnostic(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function executableEntry(
  signal: MicroBurstShadowEvaluationResult,
  quote?: MicroBurstPaperQuote,
): { price: number; model: PaperEntryPriceModel } | null {
  if (!quote || quote.status !== 'HEALTHY' || quote.observedAtMs > signal.snapshotAtMs) return null;
  if (
    !Number.isFinite(quote.bestBid) ||
    !Number.isFinite(quote.bestAsk) ||
    quote.bestAsk <= quote.bestBid
  )
    return null;
  return signal.side === 'LONG'
    ? { price: quote.bestAsk, model: 'BEST_ASK' }
    : { price: quote.bestBid, model: 'BEST_BID' };
}

function executableExit(side: 'LONG' | 'SHORT', quote?: MicroBurstPaperQuote): number | undefined {
  if (!quote || quote.status !== 'HEALTHY') return undefined;
  const price = side === 'LONG' ? quote.bestBid : quote.bestAsk;
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

function tightenStop(side: 'LONG' | 'SHORT', current: number, next: number): number {
  if (side === 'LONG') return Math.max(current, next);
  return Math.min(current, next);
}
