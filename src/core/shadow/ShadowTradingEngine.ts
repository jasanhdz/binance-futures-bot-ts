import { StrategyId } from '../../domain/strategy/StrategyIdentity';
import { shadowPositionKey, serializeShadowPositionKey } from './ShadowPositionKey';
import { executableEntryPrice, executableExitPrice } from './ShadowExecutionPricing';
import { netBpsByScenario } from './ShadowCostAccounting';
import {
  ShadowCostScenario,
  ShadowEntryIntent,
  ShadowManagementObservation,
  ShadowPosition,
  ShadowPolicyDecision,
  ShadowStrategyPolicy,
  ShadowTradeEvent,
} from './ShadowTradingTypes';
import { ShadowJournal } from './ShadowTradeJournal';

export type ShadowOpenResult =
  | { status: 'OPENED'; position: ShadowPosition }
  | { status: 'SUPPRESSED'; event: ShadowTradeEvent }
  | { status: 'DATA_UNCERTAIN'; event: ShadowTradeEvent }
  | { status: 'RECOVERY_BLOCKED'; event: ShadowTradeEvent };

export class ShadowTradingEngine {
  private readonly positions = new Map<string, ShadowPosition>();

  constructor(
    private readonly journal: ShadowJournal,
    private readonly policies: ReadonlyMap<StrategyId, ShadowStrategyPolicy>,
    private readonly costScenarios: ReadonlyMap<
      StrategyId,
      Record<string, ShadowCostScenario>
    > = new Map(),
  ) {
    for (const key of journal.loadRecoveryBlockedKeys?.() ?? [])
      this.recoveryBlocked.add(serializeShadowPositionKey(key));
    for (const position of journal.loadOpenPositions()) {
      const key = serializeShadowPositionKey(position.key);
      if (this.positions.has(key)) {
        this.recoveryBlocked.add(key);
        this.positions.delete(key);
        continue;
      }
      this.positions.set(key, position);
    }
  }

  private readonly recoveryBlocked = new Set<string>();

  open(intent: ShadowEntryIntent, quote?: ShadowManagementObservation['quote']): ShadowOpenResult {
    const key = shadowPositionKey(intent.strategyId, intent.symbol);
    const serialized = serializeShadowPositionKey(key);
    if (this.recoveryBlocked.has(serialized)) {
      const event = this.event(
        'RECOVERY_BLOCKED',
        intent.decisionReceivedAtMs,
        intent,
        undefined,
        'RECOVERY_BLOCKED',
      );
      this.journal.appendEvent(event);
      return { status: 'RECOVERY_BLOCKED', event };
    }
    const existing = this.positions.get(serialized);
    if (existing) {
      const event = this.event(
        'ENTRY_SUPPRESSED',
        intent.decisionReceivedAtMs,
        intent,
        existing.tradeId,
        'OPEN_SHADOW',
      );
      this.journal.appendEvent(event);
      return { status: 'SUPPRESSED', event };
    }
    const entryPrice = executableEntryPrice(intent.side, quote, intent.decisionReceivedAtMs);
    if (entryPrice === undefined) {
      const event = this.event(
        'UNFILLED_DATA_UNCERTAIN',
        intent.decisionReceivedAtMs,
        intent,
        undefined,
        'DATA_UNCERTAIN',
      );
      this.journal.appendEvent(event);
      return { status: 'DATA_UNCERTAIN', event };
    }
    const tradeId = `SHADOW-${intent.strategyId}-${intent.parentDecisionId}`;
    const position: ShadowPosition = {
      schemaVersion: 1,
      key,
      strategyId: intent.strategyId,
      strategyVersion: intent.strategyVersion,
      symbol: key.symbol,
      side: intent.side,
      tradeId,
      parentDecisionId: intent.parentDecisionId,
      openedAtMs: intent.decisionAtMs,
      entryDecisionPrice: intent.referencePrice,
      entryExecutablePrice: entryPrice,
      entryPrice,
      stop: intent.structuralStop,
      destination: intent.destination,
      leverage: intent.leverage,
      positionFraction: intent.positionFraction,
      state: 'OPEN_SHADOW',
      lastObservedAtMs: intent.decisionReceivedAtMs,
      peakPrice: entryPrice,
      troughPrice: entryPrice,
      mfeBps: 0,
      maeBps: 0,
      provenance: intent.provenance,
      diagnostics: intent.diagnostics,
    };
    this.positions.set(serialized, position);
    this.journal.appendPosition(position);
    this.journal.appendEvent(
      this.event('OPENED', intent.decisionReceivedAtMs, intent, tradeId, 'OPEN_SHADOW'),
    );
    return { status: 'OPENED', position };
  }

  manage(
    key: { strategyId: StrategyId; symbol: string },
    observation: ShadowManagementObservation,
  ): ShadowPosition | undefined {
    const canonicalKey = shadowPositionKey(key.strategyId, key.symbol);
    const serialized = serializeShadowPositionKey(canonicalKey);
    const current = this.positions.get(serialized);
    if (!current) return undefined;
    const policy = this.policies.get(key.strategyId);
    if (!policy) throw new Error(`SHADOW_POLICY_NOT_REGISTERED:${key.strategyId}`);
    const peakPrice = Math.max(current.peakPrice, observation.currentPrice);
    const troughPrice = Math.min(current.troughPrice, observation.currentPrice);
    const nextBase = {
      ...current,
      state: 'MANAGING' as const,
      lastObservedAtMs: observation.receivedAtMs,
      peakPrice,
      troughPrice,
      mfeBps: excursionBps(current.side, current.entryPrice, peakPrice, troughPrice, true),
      maeBps: excursionBps(current.side, current.entryPrice, peakPrice, troughPrice, false),
    };
    const decision: ShadowPolicyDecision = policy.evaluateLifecycle(nextBase, observation);
    if (decision.action === 'MOVE_STOP') {
      const next = { ...nextBase, stop: decision.stop };
      this.positions.set(serialized, next);
      this.journal.appendPosition(next);
      this.journal.appendEvent(
        this.eventFromPosition('STOP_MOVED', observation.receivedAtMs, next, decision.reason),
      );
      return next;
    }
    if (decision.action !== 'CLOSE') {
      this.positions.set(serialized, nextBase);
      this.journal.appendPosition(nextBase);
      return nextBase;
    }
    const exitPrice = executableExitPrice(
      current.side,
      observation.quote,
      observation.receivedAtMs,
    );
    if (exitPrice === undefined) {
      const uncertain = { ...nextBase, state: 'DATA_UNCERTAIN' as const };
      this.positions.set(serialized, uncertain);
      this.journal.appendPosition(uncertain);
      this.journal.appendEvent(
        this.eventFromPosition(
          'DATA_UNCERTAIN',
          observation.receivedAtMs,
          uncertain,
          'EXIT_EXECUTABLE_PRICE_UNAVAILABLE',
        ),
      );
      return uncertain;
    }
    const grossBps = signedReturnBps(current.side, current.entryPrice, exitPrice);
    const closed = {
      ...nextBase,
      state: 'CLOSED' as const,
      closedAtMs: observation.receivedAtMs,
      exitExecutablePrice: exitPrice,
      exitReason: decision.reason,
      grossBps,
      netBpsByCostScenario: netBpsByScenario(
        grossBps,
        this.costScenarios.get(key.strategyId) ?? {},
      ),
    };
    this.positions.delete(serialized);
    this.journal.appendPosition(closed);
    this.journal.appendEvent(
      this.eventFromPosition('CLOSED', observation.receivedAtMs, closed, decision.reason),
    );
    return closed;
  }

  getOpenPositions(): ShadowPosition[] {
    return [...this.positions.values()].map((position) => ({ ...position }));
  }

  getHealth(): {
    totalOpen: number;
    strategies: Record<string, { open: number; recoveryBlocked: number }>;
  } {
    const strategies: Record<string, { open: number; recoveryBlocked: number }> = {};
    for (const position of this.positions.values()) {
      const row = (strategies[position.strategyId] ??= { open: 0, recoveryBlocked: 0 });
      if (position.state !== 'CLOSED') row.open++;
    }
    for (const key of this.recoveryBlocked) {
      const [strategyId] = key.split(':');
      const row = (strategies[strategyId] ??= { open: 0, recoveryBlocked: 0 });
      row.recoveryBlocked++;
    }
    return { totalOpen: this.positions.size, strategies };
  }

  private event(
    event: ShadowTradeEvent['event'],
    atMs: number,
    intent: ShadowEntryIntent,
    tradeId: string | undefined,
    state: ShadowTradeEvent['state'],
  ): ShadowTradeEvent {
    return {
      schemaVersion: 1,
      event,
      eventAtMs: atMs,
      tradeId,
      strategyId: intent.strategyId,
      symbol: intent.symbol,
      state,
      parentDecisionId: intent.parentDecisionId,
    };
  }

  private eventFromPosition(
    event: ShadowTradeEvent['event'],
    atMs: number,
    position: ShadowPosition,
    reason?: string,
  ): ShadowTradeEvent {
    return {
      schemaVersion: 1,
      event,
      eventAtMs: atMs,
      tradeId: position.tradeId,
      strategyId: position.strategyId,
      symbol: position.symbol,
      state: position.state,
      reason,
      parentDecisionId: position.parentDecisionId,
    };
  }
}

function signedReturnBps(side: 'LONG' | 'SHORT', entry: number, exit: number): number {
  return ((side === 'LONG' ? exit - entry : entry - exit) / entry) * 10_000;
}

function excursionBps(
  side: 'LONG' | 'SHORT',
  entry: number,
  peak: number,
  trough: number,
  favorable: boolean,
): number {
  return Math.max(
    0,
    signedReturnBps(
      side,
      entry,
      favorable ? (side === 'LONG' ? peak : trough) : side === 'LONG' ? trough : peak,
    ),
  );
}
