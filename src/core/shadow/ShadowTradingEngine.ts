import { StrategyId } from '../strategy/StrategyIdentity';
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

const HOLD_CHECKPOINT_INTERVAL_MS = 60_000;

export type ShadowOpenResult =
  | { status: 'OPENED'; position: ShadowPosition }
  | { status: 'SUPPRESSED'; event: ShadowTradeEvent }
  | { status: 'DATA_UNCERTAIN'; event: ShadowTradeEvent }
  | { status: 'RECOVERY_BLOCKED'; event: ShadowTradeEvent };

export class ShadowTradingEngine {
  private readonly positions = new Map<string, ShadowPosition>();
  private readonly pendingCheckpoints = new Map<string, ShadowPosition>();
  private auxiliaryEventFailures = 0;
  private canonicalPersistenceFailures = 0;

  constructor(
    private readonly journal: ShadowJournal,
    private readonly policies: ReadonlyMap<StrategyId, ShadowStrategyPolicy>,
    private readonly costScenarios: ReadonlyMap<
      StrategyId,
      Record<string, ShadowCostScenario>
    > = new Map(),
  ) {
    for (const position of journal.loadOpenPositions()) {
      const key = serializeShadowPositionKey(position.key);
      if (this.positions.has(key)) {
        this.recoveryBlocked.add(key);
        this.positions.delete(key);
        continue;
      }
      this.positions.set(key, position);
    }
    for (const key of journal.loadRecoveryBlockedKeys?.() ?? [])
      this.recoveryBlocked.add(serializeShadowPositionKey(key));
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
      this.appendEventSafe(event);
      return { status: 'RECOVERY_BLOCKED', event };
    }
    if (!validEntryIntent(intent)) {
      const event = this.event(
        'UNFILLED_DATA_UNCERTAIN',
        intent.decisionReceivedAtMs,
        intent,
        undefined,
        'DATA_UNCERTAIN',
      );
      this.appendEventSafe(event);
      return { status: 'DATA_UNCERTAIN', event };
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
      this.appendEventSafe(event);
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
      this.appendEventSafe(event);
      return { status: 'DATA_UNCERTAIN', event };
    }
    const tradeId = `SHADOW-${intent.strategyId}-${key.symbol}-${intent.parentDecisionId}`;
    const position: ShadowPosition = {
      schemaVersion: 2,
      key,
      strategyId: intent.strategyId,
      strategyVersion: intent.strategyVersion,
      symbol: key.symbol,
      side: intent.side,
      tradeId,
      parentDecisionId: intent.parentDecisionId,
      decisionAtMs: intent.decisionAtMs,
      decisionReceivedAtMs: intent.decisionReceivedAtMs,
      openedAtMs: intent.decisionAtMs,
      openedReceivedAtMs: intent.decisionReceivedAtMs,
      entryDecisionPrice: intent.referencePrice,
      entryExecutablePrice: entryPrice,
      entryPrice,
      initialStructuralStop: intent.structuralStop,
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
    try {
      this.journal.appendPosition(position);
    } catch {
      this.canonicalPersistenceFailures++;
      this.recoveryBlocked.add(serialized);
      const event = this.event(
        'RECOVERY_BLOCKED',
        intent.decisionReceivedAtMs,
        intent,
        tradeId,
        'RECOVERY_BLOCKED',
      );
      this.appendEventSafe(event);
      return { status: 'RECOVERY_BLOCKED', event };
    }
    this.positions.set(serialized, position);
    this.appendEventSafe(
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
    const managedBase = {
      ...nextBase,
      latestManagementDecision: {
        action: decision.action,
        reason: decision.reason,
        observedAtMs: observation.receivedAtMs,
        diagnostics: decision.diagnostics,
      },
    };
    if (decision.action === 'MOVE_STOP') {
      if (!Number.isFinite(decision.stop) || decision.stop <= 0) return current;
      const improves =
        current.stop === undefined ||
        (current.side === 'LONG' ? decision.stop >= current.stop : decision.stop <= current.stop);
      if (!improves) return current;
      const next = { ...managedBase, stop: decision.stop };
      if (!this.persistCanonical(next)) return current;
      this.positions.set(serialized, next);
      this.pendingCheckpoints.delete(serialized);
      this.appendEventSafe(
        this.eventFromPosition('STOP_MOVED', observation.receivedAtMs, next, decision.reason),
      );
      return next;
    }
    if (decision.action !== 'CLOSE') {
      this.pendingCheckpoints.set(serialized, managedBase);
      const materialChange =
        managedBase.peakPrice !== current.peakPrice ||
        managedBase.troughPrice !== current.troughPrice ||
        managedBase.mfeBps !== current.mfeBps ||
        managedBase.maeBps !== current.maeBps ||
        observation.receivedAtMs - current.lastObservedAtMs >= HOLD_CHECKPOINT_INTERVAL_MS;
      if (materialChange) {
        if (!this.persistCanonical(managedBase)) return current;
        this.pendingCheckpoints.delete(serialized);
        this.positions.set(serialized, managedBase);
        return managedBase;
      }
      return current;
    }
    const exitPrice = executableExitPrice(
      current.side,
      observation.quote,
      observation.receivedAtMs,
    );
    if (exitPrice === undefined) {
      const uncertain = { ...managedBase, state: 'DATA_UNCERTAIN' as const };
      if (!this.persistCanonical(uncertain)) return current;
      this.positions.set(serialized, uncertain);
      this.appendEventSafe(
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
      ...managedBase,
      state: 'CLOSED' as const,
      closedAtMs: observation.exchangeTimeMs,
      closedReceivedAtMs: observation.receivedAtMs,
      exitExecutablePrice: exitPrice,
      exitReason: decision.reason,
      grossBps,
      netBpsByCostScenario: netBpsByScenario(
        grossBps,
        this.costScenarios.get(key.strategyId) ?? {},
      ),
    };
    if (!this.persistCanonical(closed)) {
      this.recoveryBlocked.add(serialized);
      return current;
    }
    this.positions.delete(serialized);
    this.pendingCheckpoints.delete(serialized);
    this.appendEventSafe(
      this.eventFromPosition('CLOSED', observation.receivedAtMs, closed, decision.reason),
    );
    return closed;
  }

  getOpenPositions(): ShadowPosition[] {
    return [...this.positions.values()].map((position) => ({ ...position }));
  }

  flush(): void {
    let failed = false;
    for (const [key, position] of this.pendingCheckpoints) {
      if (this.persistCanonical(position)) this.pendingCheckpoints.delete(key);
      else {
        failed = true;
        this.recoveryBlocked.add(key);
      }
    }
    this.journal.flush();
    if (failed || this.canonicalPersistenceFailures > 0)
      throw new Error('SHADOW_CANONICAL_PERSISTENCE_FAILED');
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

  getAuxiliaryEventFailureCount(): number {
    return this.auxiliaryEventFailures;
  }

  getCanonicalPersistenceFailureCount(): number {
    return this.canonicalPersistenceFailures;
  }

  private persistCanonical(position: ShadowPosition): boolean {
    try {
      this.journal.appendPosition(position);
      return true;
    } catch {
      this.canonicalPersistenceFailures++;
      return false;
    }
  }

  private appendEventSafe(event: ShadowTradeEvent): void {
    try {
      this.journal.appendEvent(event);
    } catch {
      this.auxiliaryEventFailures++;
    }
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
      metadata: position.latestManagementDecision
        ? { latestManagementDecision: position.latestManagementDecision }
        : undefined,
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
  const price = favorable ? (side === 'LONG' ? peak : trough) : side === 'LONG' ? trough : peak;
  return Math.abs(signedReturnBps(side, entry, price));
}

function validEntryIntent(intent: ShadowEntryIntent): boolean {
  return Boolean(
    intent.strategyId &&
      intent.strategyVersion &&
      intent.symbol.trim() &&
      (intent.side === 'LONG' || intent.side === 'SHORT') &&
      Number.isFinite(intent.decisionAtMs) &&
      intent.decisionAtMs >= 0 &&
      Number.isFinite(intent.decisionReceivedAtMs) &&
      intent.decisionReceivedAtMs >= 0 &&
      Number.isFinite(intent.referencePrice) &&
      intent.referencePrice > 0 &&
      intent.parentDecisionId.trim() &&
      (intent.structuralStop === undefined ||
        (Number.isFinite(intent.structuralStop) && intent.structuralStop > 0)) &&
      (intent.destination === undefined ||
        (Number.isFinite(intent.destination) && intent.destination > 0)),
  );
}
