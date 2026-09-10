import {
  isMicroBurstStrategy,
  isMicroBurstPolicy,
  samePersistedStrategy,
} from '../../core/strategy/MicroBurstLegacy';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  validMicroHistoricalClose,
  type MicroHistoricalCloseProof,
} from '../../strategies/micro-burst/domain/MicroHistoricalClose';
import type {
  ExecutionJournal,
  JournalEntry,
  JournalInput,
  JournalEventType,
  OperationScope,
} from '../../core/risk/ExecutionJournal';
import type { CancelTarget, IdentifiedStopRequest, TradingExchangePort } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';
import { RuntimeShutdownError } from '../runtime/RuntimeShutdown';
import { isMicroBurstTradePolicy } from '../../strategies/micro-burst/domain/MicroBurstTradePolicy';

interface StopRetirement {
  protocol: 'STOP_RETIREMENT_V1';
  targetOperationId: string;
  request: StopMutationRequest;
  orderId?: string;
  status: 'CANCELED' | 'FILLED' | 'RETIRED_AFTER_CONFIRMED_FLAT';
  externalClose?: MicroHistoricalCloseProof;
  executedOrderId?: string;
  lastExitAt: number;
  flatObservedAt: number[];
}

interface CancelMutationRequest extends CancelTarget {
  protocol: 'CANCEL_MUTATION_V1';
  scope: OperationScope;
  parentTradeId: string;
  parentOrderId: string;
  strategyId: string;
  operationId: string;
  mutationId: string;
  replacementCoverage?: {
    orderId: string;
    triggerPrice: number;
    quantity: number;
    entryPrice: number;
  };
}

interface CancelConfirmation {
  status: 'CANCELED';
  source: 'EXACT_TARGET_QUERY';
  observedAt: number;
}

function validCancelRequest(
  request: CancelTarget & { parentTradeId: string; parentOrderId: string; strategyId: string },
): boolean {
  return (
    [request.symbol, request.parentTradeId, request.parentOrderId].every(
      (value) => typeof value === 'string' && !!value.trim() && value.trim() === value,
    ) &&
    typeof request.orderId === 'string' &&
    /^(?:ALGO_)?[1-9]\d*$/.test(request.orderId) &&
    (request.orderId.startsWith('ALGO_') || Number.isSafeInteger(Number(request.orderId))) &&
    isMicroBurstStrategy(request.strategyId) &&
    (request.side === 'LONG' || request.side === 'SHORT') &&
    ['BOTH', request.side].includes(request.positionSide) &&
    ['STOP_MARKET', 'STOP', 'TAKE_PROFIT_MARKET', 'TAKE_PROFIT'].includes(request.type) &&
    Number.isFinite(request.stopPrice) &&
    request.stopPrice > 0
  );
}

function cancelTarget(request: CancelTarget): CancelTarget {
  return {
    symbol: request.symbol,
    side: request.side,
    orderId: request.orderId,
    positionSide: request.positionSide,
    type: request.type,
    stopPrice: request.stopPrice,
  };
}

function cancelId(
  request: Omit<CancelMutationRequest, 'operationId' | 'protocol' | 'mutationId'>,
): string {
  return `cancel:${createHash('sha256')
    .update(
      JSON.stringify([
        request.scope.account,
        request.scope.environment,
        request.parentTradeId,
        request.orderId,
      ]),
    )
    .digest('hex')}`;
}

export interface StopMutationRequest extends IdentifiedStopRequest {
  replacementKey?: string;
  protocol: 'STOP_MUTATION_V1';
  scope: OperationScope;
  parentTradeId: string;
  parentOrderId: string;
  strategyId: string;
  positionQuantity: number;
  entryPrice: number;
  mutationId: string;
  operationId: string;
}

function mutationDigest(
  scope: OperationScope,
  parentTradeId: string,
  replacementKey?: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.account,
        scope.environment,
        parentTradeId,
        ...(replacementKey ? [replacementKey] : []),
      ]),
    )
    .digest('hex');
}

/** One restoration mutation per parent trade. Unknown or vanished stops require explicit recovery. */
export class DurableStopCoordinator {
  private journal?: ExecutionJournal;
  private startup?: Promise<void>;
  private closing = false;
  private closeTask?: Promise<void>;
  private failure?: string;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly busy = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly retired = new Set<string>();
  private retirementTask?: Promise<void>;
  private readonly scope: OperationScope;

  constructor(
    private readonly deps: {
      scope: OperationScope;
      journal: () => ExecutionJournal;
      exchange: TradingExchangePort;
      wait?: (delayMs: number) => Promise<void>;
    },
  ) {
    this.scope = { ...deps.scope };
    if (!this.scope.account?.trim() || !this.scope.environment?.trim())
      throw new Error('STOP_SCOPE_REQUIRED');
  }

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('STOP_COORDINATOR_CLOSED'));
    return (this.startup ??= Promise.resolve().then(async () => {
      try {
        this.journal = this.deps.journal();
        const original = new Map<string, JournalEntry[]>();
        const retirements: JournalEntry[][] = [];
        for (const id of await this.journal.listOperations()) {
          const history = await this.journal.read(id);
          if (id.startsWith('cancel:')) {
            const request = this.cancelRequestFrom(history[0]);
            for (const entry of history) {
              if (JSON.stringify(this.cancelRequestFrom(entry)) !== JSON.stringify(request))
                throw new Error('CANCEL_REQUEST_CHANGED');
            }
            if (history[history.length - 1].event !== 'CLOSED') this.pending.add(id);
            continue;
          }
          if (id.startsWith('stop-retirement:')) {
            retirements.push(history);
            continue;
          }
          const request = this.requestFrom(history[0]);
          for (const entry of history) {
            if (JSON.stringify(this.requestFrom(entry)) !== JSON.stringify(request))
              throw new Error('STOP_REQUEST_CHANGED');
          }
          original.set(id, history);
          // Terminal mutation evidence is historical, not current position protection.
          this.pending.add(id);
        }
        for (const history of retirements) {
          const target = history[0]?.metadata?.retirement as StopRetirement | undefined;
          const source = target && original.get(target.targetOperationId);
          if (!source) throw new Error('STOP_RETIREMENT_SOURCE_MISSING');
          for (const entry of history) {
            this.retirementFrom(entry, source);
            if (JSON.stringify(entry.metadata) !== JSON.stringify(history[0].metadata))
              throw new Error('STOP_RETIREMENT_CHANGED');
          }
          if (history[history.length - 1].event === 'CLOSED') {
            this.retired.add(source[0].operationId);
            this.pending.delete(source[0].operationId);
          }
        }
        await this.reconcileCancels();
      } catch (error) {
        this.failure = `STOP_JOURNAL_BLOCKED:${String(error)}`;
        throw error;
      }
    }));
  }

  blockedReason(): string | undefined {
    return this.cancelBlockedReason() ?? (this.pending.size ? 'STOP_MUTATION_PENDING' : undefined);
  }

  cancelBlockedReason(): string | undefined {
    return (
      this.failure ??
      ([...this.pending, ...this.busy].some((id) => id.startsWith('cancel:'))
        ? 'CANCEL_MUTATION_PENDING'
        : undefined)
    );
  }

  /** The existing journal owner also drains cancellation transports and gates admission. */
  cancelProtection(
    input: CancelTarget & { parentTradeId: string; parentOrderId: string; strategyId: string },
    samePosition: () => boolean,
    replacementCoverage?: CancelMutationRequest['replacementCoverage'],
  ): Promise<boolean> {
    if (!validCancelRequest(input)) return Promise.resolve(false);
    let request: CancelMutationRequest = {
      ...cancelTarget(input),
      parentTradeId: input.parentTradeId,
      parentOrderId: input.parentOrderId,
      strategyId: input.strategyId,
      scope: { ...this.scope },
      protocol: 'CANCEL_MUTATION_V1',
      operationId: cancelId({ ...input, scope: this.scope }),
      mutationId: cancelId({ ...input, scope: this.scope }),
      ...(replacementCoverage ? { replacementCoverage: { ...replacementCoverage } } : {}),
    };
    if (this.closing || this.failure || this.busy.has(request.operationId))
      return Promise.resolve(false);
    this.busy.add(request.operationId);
    const task = Promise.resolve()
      .then(async () => {
        await this.start();
        if (!samePosition() || this.closing || this.failure) return false;
        let latest = await this.journal!.readLatest(request.operationId);
        if (latest) {
          const saved = this.cancelRequestFrom(latest);
          if (
            Object.entries(request).some(
              ([key, value]) =>
                key !== 'scope' &&
                !(key === 'strategyId' && samePersistedStrategy(saved.strategyId, value)) &&
                !isDeepStrictEqual(saved[key as keyof CancelMutationRequest], value),
            )
          )
            return false;
          request = saved;
          if (latest.event === 'CLOSED') return true;
        } else {
          if (
            !request.parentTradeId ||
            !request.parentOrderId ||
            !isMicroBurstStrategy(request.strategyId)
          )
            return false;
          if (
            (await this.deps.exchange
              .readCancelTarget?.(cancelTarget(request))
              .catch(() => null)) !== 'NEW' ||
            !samePosition()
          )
            return false;
          this.pending.add(request.operationId);
          latest = await this.appendCancel(request, 'PREPARED');
          // PREPARED recovered on another call is observation-only, even if no send occurred.
          if (!samePosition() || this.closing || !this.deps.exchange.readFreshActivePosition)
            return false;
          if (
            !(request.replacementCoverage
              ? await this.confirmReplacementCoverage(request)
              : (await this.deps.exchange.readFreshActivePosition(request.symbol, request.side)) ===
                null) ||
            !samePosition() ||
            this.closing
          )
            return false;
          try {
            await this.deps.exchange.cancelOrderById(request.symbol, request.orderId);
          } catch {
            // A lost response does not authorize a retry. Only an exact query can settle it.
          }
          latest = await this.appendCancel(request, 'UNKNOWN');
        }
        return await this.observeCancel(request, latest);
      })
      .catch((error) => {
        this.failure ??= `CANCEL_MUTATION_BLOCKED:${String(error)}`;
        return false;
      })
      .finally(() => {
        this.busy.delete(request.operationId);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    return task;
  }

  private cancelRequestFrom(entry: JournalInput): CancelMutationRequest {
    const request = entry.metadata?.request as CancelMutationRequest | undefined;
    if (
      !request ||
      request.protocol !== 'CANCEL_MUTATION_V1' ||
      request.scope.account !== this.scope.account ||
      request.scope.environment !== this.scope.environment ||
      entry.scope.account !== this.scope.account ||
      entry.scope.environment !== this.scope.environment ||
      request.operationId !== entry.operationId ||
      cancelId(request) !== entry.operationId ||
      request.mutationId !== request.operationId ||
      request.symbol !== entry.symbol ||
      request.side !== entry.side ||
      request.orderId !== entry.orderId ||
      !isMicroBurstStrategy(request.strategyId) ||
      request.strategyId !== entry.strategyId ||
      !validCancelRequest(request) ||
      entry.clientOrderId !== undefined ||
      !['PREPARED', 'UNKNOWN', 'CLOSE_PENDING', 'CLOSED'].includes(entry.event) ||
      entry.metadata?.journalOperationMeaning !== 'CANCEL_MUTATION_NOT_TRADE' ||
      entry.metadata?.terminalMeaning !== 'CANCEL_OBSERVED_NOT_POSITION_FLAT'
    )
      throw new Error('CANCEL_PROTOCOL_OR_SCOPE_CONFLICT');
    const coverage = request.replacementCoverage;
    if (
      coverage &&
      (request.positionSide !== 'BOTH' ||
        request.type !== 'STOP_MARKET' ||
        typeof coverage.orderId !== 'string' ||
        !/^(?:ALGO_)?[1-9]\d*$/.test(coverage.orderId) ||
        coverage.orderId === request.orderId ||
        ![coverage.triggerPrice, coverage.quantity, coverage.entryPrice].every(
          (v) => Number.isFinite(v) && v > 0,
        ) ||
        (request.side === 'LONG'
          ? coverage.triggerPrice <= request.stopPrice
          : coverage.triggerPrice >= request.stopPrice))
    )
      throw new Error('CANCEL_REPLACEMENT_COVERAGE_INVALID');
    if (entry.event === 'CLOSE_PENDING' || entry.event === 'CLOSED') {
      const confirmation = entry.metadata?.confirmation as CancelConfirmation | undefined;
      if (
        !confirmation ||
        confirmation.status !== 'CANCELED' ||
        confirmation.source !== 'EXACT_TARGET_QUERY' ||
        !Number.isSafeInteger(confirmation.observedAt) ||
        confirmation.observedAt < 0 ||
        confirmation.observedAt > entry.timestampMs
      )
        throw new Error('CANCEL_CONFIRMATION_INVALID');
    }
    return request;
  }

  private async confirmReplacementCoverage(
    request: Pick<CancelMutationRequest, 'symbol' | 'side' | 'orderId' | 'replacementCoverage'>,
  ): Promise<boolean> {
    const coverage = request.replacementCoverage!;
    const exchange = this.deps.exchange;
    const orders = await exchange.listCloseOrdersForSide(request.symbol, request.side);
    if (
      !orders.some(
        (order) =>
          order.orderId === coverage.orderId &&
          order.orderId !== request.orderId &&
          order.owner === 'BOT' &&
          order.type === 'STOP_MARKET' &&
          order.side === (request.side === 'LONG' ? 'SELL' : 'BUY') &&
          order.positionSide === 'BOTH' &&
          order.stopPrice === coverage.triggerPrice &&
          (order.closePosition === true ||
            (order.reduceOnly === true && Number(order.quantity) === coverage.quantity)),
      )
    )
      return false;
    const status = await exchange.readCancelTarget?.({
      symbol: request.symbol,
      side: request.side,
      positionSide: 'BOTH',
      type: 'STOP_MARKET',
      orderId: coverage.orderId,
      stopPrice: coverage.triggerPrice,
    });
    if (status !== 'NEW') return false;
    const position = await exchange.readFreshActivePosition?.(request.symbol, request.side);
    return (
      !!position &&
      position.sideMode === 'BOTH' &&
      position.qtyAbs === coverage.quantity &&
      position.entryPrice === coverage.entryPrice
    );
  }

  private appendCancel(
    request: CancelMutationRequest,
    event: JournalEventType,
    confirmation?: CancelConfirmation,
  ): Promise<JournalEntry> {
    const entry: JournalInput = {
      id: randomUUID(),
      operationId: request.operationId,
      scope: request.scope,
      symbol: request.symbol,
      side: request.side,
      strategyId: request.strategyId,
      orderId: request.orderId,
      event,
      timestampMs: Date.now(),
      metadata: {
        request,
        journalOperationMeaning: 'CANCEL_MUTATION_NOT_TRADE',
        terminalMeaning: 'CANCEL_OBSERVED_NOT_POSITION_FLAT',
        ...(confirmation ? { confirmation } : {}),
      },
    };
    this.cancelRequestFrom(entry);
    return this.journal!.append(entry);
  }

  private async observeCancel(
    request: CancelMutationRequest,
    latest: JournalEntry,
  ): Promise<boolean> {
    const status = await this.deps.exchange
      .readCancelTarget?.(cancelTarget(request))
      .catch(() => null);
    if (status !== 'CANCELED') {
      if (latest.event === 'PREPARED' || latest.event === 'CLOSE_PENDING')
        await this.appendCancel(request, 'UNKNOWN');
      return false;
    }
    const confirmation: CancelConfirmation = {
      status: 'CANCELED',
      source: 'EXACT_TARGET_QUERY',
      observedAt: Date.now(),
    };
    if (latest.event !== 'CLOSE_PENDING')
      latest = await this.appendCancel(request, 'CLOSE_PENDING', confirmation);
    await this.appendCancel(request, 'CLOSED', confirmation);
    this.pending.delete(request.operationId);
    return true;
  }

  private async reconcileCancels(): Promise<void> {
    for (const id of this.pending) {
      if (!id.startsWith('cancel:') || this.busy.has(id) || this.closing) continue;
      this.busy.add(id);
      try {
        const latest = await this.journal!.readLatest(id);
        if (latest) await this.observeCancel(this.cancelRequestFrom(latest), latest);
      } finally {
        this.busy.delete(id);
      }
    }
  }

  async tighten(
    symbol: string,
    store: StateStore,
    triggerPrice: number,
    policyDigest: string,
  ): Promise<boolean> {
    const state = store.get();
    if (
      !store.flush ||
      this.closing ||
      !state.lastSide ||
      !state.lastTradeId ||
      !state.lastOrderId ||
      state.positionOwner !== 'BOT' ||
      state.mode === 'IDLE' ||
      !isMicroBurstTradePolicy(state.microBurstTradePolicy, {
        strategyId: state.lastStrategy ?? '',
        strategyVersion: state.lastStrategyVersion ?? '',
        configHash: state.lastConfigHash,
        codeCommitSha: state.lastCodeCommitSha ?? '',
      }) ||
      state.microBurstTradePolicy.digest !== policyDigest
    )
      return false;
    const side = state.lastSide;
    const pending = state.microBurstStopMove;
    let target = pending?.triggerPrice ?? triggerPrice;
    if (!pending) {
      if (!Number.isFinite(state.lastLeverage) || state.lastLeverage! <= 0) return false;
      const filters = await this.deps.exchange.getSymbolFilters(symbol, state.lastLeverage!);
      if (
        !Number.isFinite(filters.tickSize) ||
        filters.tickSize <= 0 ||
        !Number.isInteger(filters.pricePrecision) ||
        filters.pricePrecision < 0 ||
        filters.pricePrecision > 18
      )
        return false;
      const ticks = target / filters.tickSize;
      target = Number(
        (
          (side === 'LONG' ? Math.ceil(ticks - 1e-12) : Math.floor(ticks + 1e-12)) *
          filters.tickSize
        ).toFixed(filters.pricePrecision),
      );
    }
    const key = pending?.key ?? `${policyDigest}:${target}`;
    const same = () => {
      const s = store.get();
      return (
        s.lastTradeId === state.lastTradeId &&
        s.lastOrderId === state.lastOrderId &&
        s.lastSide === side &&
        s.positionOwner === 'BOT' &&
        s.mode === state.mode &&
        s.lastEntryQty === state.lastEntryQty &&
        s.lastEntryPrice === state.lastEntryPrice &&
        s.lastStopPrice === state.lastStopPrice &&
        isDeepStrictEqual(s.microBurstTradePolicy, state.microBurstTradePolicy) &&
        s.microBurstStopMove?.key === key
      );
    };
    if (pending && (pending.policyDigest !== policyDigest || key !== `${policyDigest}:${target}`))
      return false;
    const position = await this.deps.exchange.readFreshActivePosition?.(symbol, side);
    if (
      !position ||
      position.sideMode !== 'BOTH' ||
      position.qtyAbs !== state.lastEntryQty ||
      position.entryPrice !== state.lastEntryPrice ||
      !Number.isFinite(target) ||
      !Number.isFinite(state.lastStopPrice) ||
      (side === 'LONG' ? target <= state.lastStopPrice! : target >= state.lastStopPrice!)
    )
      return false;
    const orders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
    const mark = await this.deps.exchange.getMarkPrice(symbol);
    if (
      !Number.isFinite(mark) ||
      (side === 'LONG' ? target >= mark : target <= mark) ||
      !orders.some(
        (o) =>
          o.owner === 'BOT' &&
          o.type === 'STOP_MARKET' &&
          o.side === (side === 'LONG' ? 'SELL' : 'BUY') &&
          o.positionSide === position.sideMode &&
          (o.stopPrice === state.lastStopPrice || (pending && o.stopPrice === target)) &&
          (o.closePosition === true ||
            (o.positionSide === 'BOTH' &&
              o.reduceOnly === true &&
              Number(o.quantity) === position.qtyAbs)),
      )
    )
      return false;
    const retirementTargets =
      pending?.retirementTargets ??
      orders
        .filter(
          (o) =>
            o.owner === 'BOT' &&
            o.type === 'STOP_MARKET' &&
            o.side === (side === 'LONG' ? 'SELL' : 'BUY') &&
            o.positionSide === position.sideMode &&
            o.stopPrice === state.lastStopPrice,
        )
        .map((o) => ({
          symbol,
          side,
          orderId: o.orderId,
          positionSide: position.sideMode,
          type: o.type,
          stopPrice: o.stopPrice,
        }));
    if (!retirementTargets.length) return false;
    if (!pending || pending.retirementTargets === undefined) {
      const current = store.get();
      if (
        current.lastTradeId !== state.lastTradeId ||
        current.lastOrderId !== state.lastOrderId ||
        current.mode !== state.mode ||
        current.positionOwner !== 'BOT' ||
        current.lastStopPrice !== state.lastStopPrice ||
        current.microBurstStopMove !== pending
      )
        return false;
      store.set({
        microBurstStopMove: { key, triggerPrice: target, policyDigest, retirementTargets },
      });
      await store.flush();
    }
    if (!same()) return false;
    // The existing covering stop stays in place. UNKNOWN replacement never permits a resend.
    const confirmed = await this.supervise(
      {
        symbol,
        side,
        positionSide: position.sideMode,
        triggerPrice: target,
        closePosition: false,
        quantity: position.qtyAbs,
        reduceOnly: true,
        workingType: 'MARK_PRICE',
        parentTradeId: state.lastTradeId,
        parentOrderId: state.lastOrderId,
        strategyId: 'MICRO_BURST',
        positionQuantity: position.qtyAbs,
        entryPrice: position.entryPrice,
        replacementKey: key,
      },
      same,
      true,
    );
    if (!confirmed || !same()) return false;
    const replacementProof = await this.journal!.readLatest(
      `stop:${mutationDigest(this.scope, state.lastTradeId, key)}`,
    );
    if (replacementProof?.event !== 'CLOSED' || !replacementProof.orderId || !same()) return false;
    const refreshedOrders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
    const covering = refreshedOrders.find(
      (o) =>
        o.orderId === replacementProof.orderId &&
        o.owner === 'BOT' &&
        o.type === 'STOP_MARKET' &&
        o.side === (side === 'LONG' ? 'SELL' : 'BUY') &&
        o.positionSide === position.sideMode &&
        o.stopPrice === target &&
        (o.closePosition === true ||
          (o.reduceOnly === true && Number(o.quantity) === position.qtyAbs)),
    );
    if (!covering || !same()) return false;
    for (const old of retirementTargets) {
      if (old.orderId === covering.orderId || !same()) return false;
      if (
        !(await this.cancelProtection(
          {
            ...old,
            parentTradeId: state.lastTradeId,
            parentOrderId: state.lastOrderId,
            strategyId: 'MICRO_BURST',
          },
          same,
          {
            orderId: covering.orderId,
            triggerPrice: target,
            quantity: position.qtyAbs,
            entryPrice: position.entryPrice,
          },
        ))
      )
        return false;
    }
    // Confirmation above is historical after awaits; recheck before projecting the active stop.
    if (
      !same() ||
      !(await this.confirmReplacementCoverage({
        symbol,
        side,
        orderId: retirementTargets[0].orderId,
        replacementCoverage: {
          orderId: covering.orderId,
          triggerPrice: target,
          quantity: position.qtyAbs,
          entryPrice: position.entryPrice,
        },
      })) ||
      !same()
    )
      return false;
    store.set({
      lastStopPrice: target,
      microBurstActiveStopKey: key,
      microBurstStopMove: undefined,
    });
    const projected = () => {
      const current = store.get();
      return (
        current.lastTradeId === state.lastTradeId &&
        current.lastOrderId === state.lastOrderId &&
        current.lastSide === side &&
        current.mode === state.mode &&
        current.positionOwner === 'BOT' &&
        current.lastStopPrice === target &&
        current.microBurstActiveStopKey === key &&
        current.microBurstStopMove === undefined
      );
    };
    try {
      await store.flush();
    } catch (error) {
      if (projected())
        store.set({
          lastStopPrice: state.lastStopPrice,
          microBurstActiveStopKey: state.microBurstActiveStopKey,
          microBurstStopMove: { key, triggerPrice: target, policyDigest, retirementTargets },
        });
      throw error;
    }
    return projected();
  }

  async supervise(
    input: Omit<
      StopMutationRequest,
      'protocol' | 'scope' | 'mutationId' | 'operationId' | 'clientOrderId'
    >,
    samePosition: () => boolean,
    allowFresh: boolean,
  ): Promise<boolean> {
    if (this.closing || this.failure) return false;
    const snapshot = { ...input };
    if (!snapshot.parentTradeId?.trim() || !snapshot.parentOrderId?.trim()) return false;
    const digest = mutationDigest(this.scope, snapshot.parentTradeId, snapshot.replacementKey);
    const operationId = `stop:${digest}`;
    if (this.retired.has(operationId)) return false;
    if (this.busy.has(operationId)) return false;
    this.busy.add(operationId);
    this.pending.add(operationId);
    const task = Promise.resolve()
      .then(async () => {
        await this.start();
        if (this.failure || !samePosition()) return false;
        if (this.retired.has(operationId)) return false;
        let latest = await this.journal!.readLatest(operationId);
        let request: StopMutationRequest;
        if (latest) {
          this.pending.add(operationId);
          request = this.requestFrom((await this.journal!.read(operationId))[0]);
          // Historical close-all adjustments remain observation-only with their original bytes.
          const legacyCoverage =
            snapshot.replacementKey &&
            request.closePosition === true &&
            snapshot.closePosition === false;
          if (
            Object.entries(snapshot).some(
              ([key, value]) =>
                !(legacyCoverage && ['closePosition', 'quantity', 'reduceOnly'].includes(key)) &&
                !(key === 'strategyId' && samePersistedStrategy(request.strategyId, value)) &&
                request[key as keyof StopMutationRequest] !== value,
            )
          )
            return false;
        } else {
          const orders = await this.deps.exchange
            .listCloseOrdersForSide(snapshot.symbol, snapshot.side)
            .catch(() => null);
          if (!orders) return false;
          if (
            orders.some(
              (order) =>
                order.owner === 'BOT' &&
                order.type === 'STOP_MARKET' &&
                order.side === (snapshot.side === 'LONG' ? 'SELL' : 'BUY') &&
                order.positionSide === snapshot.positionSide &&
                order.stopPrice === snapshot.triggerPrice &&
                (snapshot.closePosition
                  ? order.closePosition === true
                  : order.closePosition === false &&
                    order.reduceOnly === true &&
                    Number(order.quantity) === snapshot.quantity),
            )
          ) {
            if (!samePosition()) return false;
            this.pending.delete(operationId);
            return true;
          }
          if (
            !allowFresh ||
            !this.deps.exchange.sendStopCloseOnce ||
            !this.deps.exchange.readStopCloseByClientOrderId
          )
            return false;
          request = {
            ...snapshot,
            scope: this.scope,
            protocol: 'STOP_MUTATION_V1',
            operationId,
            mutationId: `bot_sl_${digest.slice(0, 28)}`,
            clientOrderId: `bot_sl_${digest.slice(0, 28)}`,
          };
          this.pending.add(operationId);
          this.validateCoverage(request);
          latest = await this.append(request, 'PREPARED');
          // Only the owner that created this durable PREPARED may submit, once.
          if (!samePosition() || this.closing) return false;
          const beforeSend = await (
            request.closePosition
              ? this.deps.exchange.readActivePosition(request.symbol, request.side)
              : this.deps.exchange.readFreshActivePosition?.(request.symbol, request.side)
          )?.catch(() => null);
          if (
            !beforeSend ||
            beforeSend.sideMode !== request.positionSide ||
            beforeSend.qtyAbs !== request.positionQuantity ||
            beforeSend.entryPrice !== request.entryPrice ||
            !samePosition() ||
            this.closing
          )
            return false;
          try {
            const receipt = await this.deps.exchange.sendStopCloseOnce({
              ...request,
              scope: { ...request.scope },
            } as StopMutationRequest);
            if (receipt.clientOrderId !== request.clientOrderId || !receipt.orderId)
              throw new Error('STOP_ACK_IDENTITY');
            latest = await this.append(request, 'SUBMITTED', receipt.orderId);
          } catch {
            if (this.failure) return false;
            latest = await this.append(request, 'UNKNOWN');
          }
        }
        if (!samePosition()) return false;
        // A historical CLOSED confirms a mutation outcome, never current protection or flatness.
        const observed = await this.deps.exchange
          .readStopCloseByClientOrderId?.({
            ...request,
            scope: { ...request.scope },
          } as StopMutationRequest)
          .catch(() => null);
        if (
          !observed ||
          observed.clientOrderId !== request.clientOrderId ||
          !observed.orderId ||
          (latest.orderId && latest.orderId !== observed.orderId) ||
          !samePosition()
        )
          return false;
        const position = await (
          request.closePosition
            ? this.deps.exchange.readActivePosition(request.symbol, request.side)
            : this.deps.exchange.readFreshActivePosition?.(request.symbol, request.side)
        )?.catch(() => null);
        if (
          !position ||
          position.sideMode !== request.positionSide ||
          position.qtyAbs !== request.positionQuantity ||
          position.entryPrice !== request.entryPrice ||
          !samePosition()
        )
          return false;
        if (latest.event === 'PREPARED') latest = await this.append(request, 'UNKNOWN');
        if (['SUBMITTED', 'UNKNOWN', 'RECOVERY_REQUIRED'].includes(latest.event))
          latest = await this.append(request, 'OPEN_CONFIRMED', observed.orderId);
        if (latest.event === 'OPEN_CONFIRMED')
          latest = await this.append(request, 'PROTECTED', observed.orderId);
        if (latest.event === 'PROTECTED')
          latest = await this.append(request, 'CLOSE_PENDING', observed.orderId);
        if (latest.event === 'CLOSE_PENDING')
          await this.append(request, 'CLOSED', observed.orderId);
        if (!samePosition()) return false;
        this.pending.delete(operationId);
        return true;
      })
      .catch((error) => {
        this.failure ??= `STOP_JOURNAL_BLOCKED:${String(error)}`;
        return false;
      })
      .finally(() => {
        this.busy.delete(operationId);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    return task;
  }

  /** Observation-only settlement. Does not send, cancel, change BotState or resolve PnL. */
  retireHistoricalClose(proof: MicroHistoricalCloseProof, same: () => boolean): Promise<boolean> {
    if (
      !validMicroHistoricalClose(proof) ||
      this.closing ||
      this.failure ||
      this.tasks.size ||
      this.busy.size ||
      !this.journal ||
      !same()
    )
      return Promise.resolve(false);
    const identity = proof.identity;
    const id = `stop:${mutationDigest(this.scope, identity.tradeId)}`;
    this.busy.add(id);
    this.pending.add(id);
    const task = (async () => {
      const inventory = await this.journal!.listOperations();
      // Do not retire a trade while an unrelated mutation or a cancellation can still be in flight.
      if (!same() || this.closing || [...this.pending].some((key) => key !== id)) return false;
      const history = await this.journal!.read(id);
      if (
        !history.length ||
        inventory.some((key) => key.startsWith('cancel:') && this.pending.has(key))
      )
        return false;
      const request = this.requestFrom(history[0]);
      if (
        request.parentTradeId !== identity.tradeId ||
        request.parentOrderId !== identity.entryOrderId ||
        request.symbol !== identity.symbol ||
        request.side !== identity.side ||
        request.positionQuantity !== identity.quantity ||
        request.entryPrice !== identity.provenance.entryPrice ||
        request.strategyId !== identity.provenance.identity.strategyId ||
        request.replacementKey ||
        proof.flat[1].observedAtMs > Date.now() ||
        Date.now() - proof.flat[1].observedAtMs > 10_000 ||
        identity.closedAtMs < history[0].timestampMs
      )
        return false;
      const retirementId = id.replace(/^stop:/, 'stop-retirement:');
      let latest = await this.journal!.readLatest(retirementId);
      const retirement: StopRetirement = latest
        ? this.retirementFrom(latest, history)
        : {
            protocol: 'STOP_RETIREMENT_V1',
            targetOperationId: id,
            request,
            status: 'RETIRED_AFTER_CONFIRMED_FLAT',
            externalClose: proof,
            lastExitAt: identity.closedAtMs,
            flatObservedAt: [
              proof.flat[0].startedAtMs,
              proof.flat[0].observedAtMs,
              proof.flat[1].observedAtMs,
            ],
          };
      for (const event of ['PREPARED', 'CLOSE_PENDING', 'CLOSED'] as const) {
        if (
          latest &&
          ['PREPARED', 'CLOSE_PENDING', 'CLOSED'].indexOf(latest.event) >=
            ['PREPARED', 'CLOSE_PENDING', 'CLOSED'].indexOf(event)
        )
          continue;
        if (!same() || this.closing) return false;
        latest = await this.journal!.append({
          id: randomUUID(),
          operationId: retirementId,
          scope: this.scope,
          symbol: request.symbol,
          side: request.side,
          strategyId: request.strategyId,
          event,
          timestampMs: Date.now(),
          metadata: {
            journalOperationMeaning: 'STOP_RETIREMENT_NOT_ACCOUNTING',
            retirement,
          },
        });
      }
      await this.journal!.flush();
      if (!same() || this.closing) return false;
      this.retired.add(id);
      this.pending.delete(id);
      return true;
    })()
      .catch((error) => {
        this.failure ??= `STOP_RETIREMENT_JOURNAL_BLOCKED:${String(error)}`;
        return false;
      })
      .finally(() => {
        this.busy.delete(id);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    return task;
  }

  /** Observation-only settlement. Does not send, cancel, change BotState or resolve PnL. */
  reconcileClosed(stateForSymbol: (symbol: string) => StateStore): Promise<void> {
    if (this.retirementTask) return this.retirementTask;
    if (!this.journal || this.closing || this.failure) return Promise.resolve();
    const task = Promise.resolve()
      .then(async () => {
        await this.reconcileCancels();
        const inventory = await this.journal!.listOperations();
        for (const id of new Set([
          ...this.pending,
          ...inventory.filter((key) => key.startsWith('stop:')),
        ])) {
          if (id.startsWith('cancel:')) continue;
          if (this.closing || this.failure) return;
          if (this.retired.has(id)) continue;
          if (this.busy.has(id)) continue;
          this.busy.add(id);
          try {
            const history = await this.journal!.read(id);
            if (!history.length) continue; // An unsubmitted legacy latch has no identified evidence.
            const request = this.requestFrom(history[0]);
            const store = stateForSymbol(request.symbol);
            const lastExitAt = store.get().lastExitAt;
            const sameClosed = () => {
              const state = store.get();
              return (
                state.mode === 'IDLE' &&
                state.positionOwner === 'BOT' &&
                state.lastTradeId === request.parentTradeId &&
                state.lastOrderId === request.parentOrderId &&
                state.lastSide === request.side &&
                samePersistedStrategy(state.lastStrategy, request.strategyId) &&
                Number.isSafeInteger(lastExitAt) &&
                lastExitAt! >= history[0].timestampMs &&
                lastExitAt! <= Date.now() &&
                state.lastExitAt === lastExitAt
              );
            };
            const exchange = this.deps.exchange;
            if (!sameClosed()) continue;
            this.pending.add(id);
            if (!store.flush || !exchange.readFreshActivePosition || !exchange.readStopCloseState)
              continue;
            let proof: StopRetirement;
            try {
              // Confirm that the local operational close is durable, not merely an in-memory patch.
              await store.flush();
              if (!sameClosed()) continue;
              const query = { ...request, scope: { ...request.scope } };
              const canceled = await exchange.readStopCloseState(query);
              const triggered =
                canceled === null && isMicroBurstPolicy(store.get().lastStrategyVersion)
                  ? await exchange.readTriggeredStop?.(query, request.positionQuantity)
                  : null;
              const observed =
                canceled ?? (triggered ? { ...triggered, status: 'FILLED' as const } : null);
              const last = history[history.length - 1];
              if (
                !observed ||
                !['CANCELED', 'FILLED'].includes(observed.status) ||
                observed.clientOrderId !== request.clientOrderId ||
                !observed.orderId ||
                (last.orderId && last.orderId !== observed.orderId)
              )
                continue;
              const flatObservedAt: number[] = [];
              if ((await exchange.readFreshActivePosition(request.symbol, request.side)) !== null)
                continue;
              flatObservedAt.push(Date.now());
              await (this.deps.wait?.(300) ?? new Promise((resolve) => setTimeout(resolve, 300)));
              if ((await exchange.readFreshActivePosition(request.symbol, request.side)) !== null)
                continue;
              flatObservedAt.push(Date.now());
              const orders = await exchange.listCloseOrdersForSide(request.symbol, request.side);
              if (!Array.isArray(orders) || orders.some((order) => order.owner === 'BOT')) continue;
              if (
                (await exchange.readFreshActivePosition(request.symbol, request.side)) !== null ||
                !sameClosed()
              )
                continue;
              flatObservedAt.push(Date.now());
              proof = {
                protocol: 'STOP_RETIREMENT_V1',
                targetOperationId: id,
                request,
                orderId: observed.orderId,
                status: observed.status as 'CANCELED' | 'FILLED',
                ...(triggered ? { executedOrderId: triggered.executedOrderId } : {}),
                lastExitAt: lastExitAt!,
                flatObservedAt,
              };
            } catch {
              continue;
            } // Unknown exchange/state evidence retains the block, without mutation.
            const retirementId = id.replace(/^stop:/, 'stop-retirement:');
            let retirement = await this.journal!.readLatest(retirementId);
            if (retirement) {
              proof = this.retirementFrom(retirement, history);
            }
            const append = async (event: JournalEventType) => {
              const timestampMs = Date.now();
              if (
                proof.flatObservedAt.some(
                  (time, index) =>
                    time < proof.lastExitAt ||
                    time > timestampMs ||
                    (index > 0 && time < proof.flatObservedAt[index - 1]),
                )
              )
                throw new Error('STOP_RETIREMENT_CLOCK_INVALID');
              return this.journal!.append({
                id: randomUUID(),
                operationId: retirementId,
                scope: request.scope,
                symbol: request.symbol,
                side: request.side,
                strategyId: request.strategyId,
                event,
                timestampMs,
                metadata: {
                  journalOperationMeaning: 'STOP_RETIREMENT_NOT_ACCOUNTING',
                  retirement: proof,
                },
              });
            };
            if (!sameClosed() || this.closing) continue;
            if (proof.status === 'FILLED' && proof.executedOrderId) {
              store.set({
                microBurstStopCloseOrderIds: [
                  ...new Set([
                    ...(store.get().microBurstStopCloseOrderIds ?? []),
                    proof.executedOrderId,
                  ]),
                ],
              });
              await store.flush!();
              if (!sameClosed() || this.closing) continue;
            }
            if (!retirement) retirement = await append('PREPARED');
            if (!sameClosed() || this.closing) continue;
            if (retirement.event === 'PREPARED') retirement = await append('CLOSE_PENDING');
            if (!sameClosed() || this.closing) continue;
            if (retirement.event === 'CLOSE_PENDING') retirement = await append('CLOSED');
            if (retirement.event === 'CLOSED' && sameClosed()) {
              this.retired.add(id);
              this.pending.delete(id);
            }
          } catch (error) {
            this.failure ??= `STOP_RETIREMENT_JOURNAL_BLOCKED:${String(error)}`;
          } finally {
            this.busy.delete(id);
          }
        }
      })
      .catch((error) => {
        this.failure ??= `STOP_RETIREMENT_JOURNAL_BLOCKED:${String(error)}`;
      })
      .finally(() => {
        this.tasks.delete(task);
        this.retirementTask = undefined;
      });
    this.retirementTask = task;
    this.tasks.add(task);
    return task;
  }

  private retirementFrom(entry: JournalEntry, source: JournalEntry[]): StopRetirement {
    const proof = entry.metadata?.retirement as StopRetirement | undefined;
    const request = this.requestFrom(source[0]);
    const last = source[source.length - 1];
    if (
      !proof ||
      proof.protocol !== 'STOP_RETIREMENT_V1' ||
      proof.targetOperationId !== request.operationId ||
      entry.operationId !== request.operationId.replace(/^stop:/, 'stop-retirement:') ||
      entry.scope.account !== this.scope.account ||
      entry.scope.environment !== this.scope.environment ||
      entry.symbol !== request.symbol ||
      entry.side !== request.side ||
      entry.strategyId !== request.strategyId ||
      entry.metadata?.journalOperationMeaning !== 'STOP_RETIREMENT_NOT_ACCOUNTING' ||
      !['PREPARED', 'CLOSE_PENDING', 'CLOSED'].includes(entry.event) ||
      JSON.stringify(proof.request) !== JSON.stringify(request) ||
      !['CANCELED', 'FILLED', 'RETIRED_AFTER_CONFIRMED_FLAT'].includes(proof.status) ||
      (proof.status === 'FILLED' &&
        (typeof proof.executedOrderId !== 'string' || !/^[1-9]\d*$/.test(proof.executedOrderId))) ||
      (proof.status !== 'RETIRED_AFTER_CONFIRMED_FLAT' &&
        (typeof proof.orderId !== 'string' ||
          !proof.orderId.trim() ||
          (last.orderId && proof.orderId !== last.orderId))) ||
      (proof.status === 'RETIRED_AFTER_CONFIRMED_FLAT' &&
        (!proof.externalClose ||
          !validMicroHistoricalClose(proof.externalClose) ||
          proof.orderId !== undefined ||
          proof.executedOrderId !== undefined ||
          proof.externalClose.identity.tradeId !== request.parentTradeId ||
          proof.externalClose.identity.entryOrderId !== request.parentOrderId ||
          proof.externalClose.identity.symbol !== request.symbol ||
          proof.externalClose.identity.side !== request.side ||
          proof.externalClose.identity.quantity !== request.positionQuantity ||
          proof.externalClose.identity.provenance.entryPrice !== request.entryPrice ||
          proof.externalClose.identity.provenance.identity.strategyId !== request.strategyId ||
          proof.lastExitAt !== proof.externalClose.identity.closedAtMs ||
          !isDeepStrictEqual(proof.flatObservedAt, [
            proof.externalClose.flat[0].startedAtMs,
            proof.externalClose.flat[0].observedAtMs,
            proof.externalClose.flat[1].observedAtMs,
          ]))) ||
      !Number.isSafeInteger(proof.lastExitAt) ||
      proof.lastExitAt < source[0].timestampMs ||
      !Array.isArray(proof.flatObservedAt) ||
      proof.flatObservedAt.length !== 3 ||
      proof.flatObservedAt.some(
        (time, index) =>
          !Number.isSafeInteger(time) ||
          time < proof.lastExitAt ||
          time > entry.timestampMs ||
          (index > 0 && time < proof.flatObservedAt[index - 1]),
      ) ||
      entry.sequence <= last.sequence
    )
      throw new Error('STOP_RETIREMENT_INVALID');
    return proof;
  }

  private requestFrom(entry: JournalEntry): StopMutationRequest {
    const request = entry.metadata?.request as StopMutationRequest | undefined;
    if (
      !request ||
      request.protocol !== 'STOP_MUTATION_V1' ||
      request.scope.account !== this.scope.account ||
      request.scope.environment !== this.scope.environment ||
      entry.scope.account !== this.scope.account ||
      entry.scope.environment !== this.scope.environment ||
      request.operationId !== entry.operationId ||
      request.clientOrderId !== entry.clientOrderId ||
      request.symbol !== entry.symbol ||
      request.side !== entry.side ||
      request.strategyId !== entry.strategyId ||
      request.triggerPrice !== entry.stopPrice ||
      request.positionQuantity !== entry.quantity ||
      request.entryPrice !== entry.entryPrice ||
      request.workingType !== 'MARK_PRICE' ||
      request.mutationId !== request.clientOrderId ||
      !/^bot_sl_[a-f0-9]{28}$/.test(request.clientOrderId) ||
      !request.parentTradeId ||
      !request.parentOrderId ||
      !['BOTH', request.side].includes(request.positionSide) ||
      entry.metadata?.journalOperationMeaning !== 'STOP_MUTATION_NOT_TRADE' ||
      entry.metadata?.terminalMeaning !== 'STOP_OBSERVED_NOT_POSITION_FLAT'
    )
      throw new Error('STOP_PROTOCOL_OR_SCOPE_CONFLICT');
    this.validateCoverage(request);
    const digest = mutationDigest(this.scope, request.parentTradeId, request.replacementKey);
    if (
      request.replacementKey !== undefined &&
      !/^sha256:[a-f0-9]{64}:[0-9]+(?:\.[0-9]+)?$/.test(request.replacementKey)
    )
      throw new Error('STOP_REPLACEMENT_IDENTITY_INVALID');
    if (
      request.operationId !== `stop:${digest}` ||
      request.clientOrderId !== `bot_sl_${digest.slice(0, 28)}`
    )
      throw new Error('STOP_MUTATION_IDENTITY_CONFLICT');
    return request;
  }

  private validateCoverage(request: StopMutationRequest): void {
    if (request.closePosition === true) {
      if (request.quantity === undefined && request.reduceOnly === undefined) return;
    } else if (
      request.closePosition === false &&
      request.positionSide === 'BOTH' &&
      request.reduceOnly === true &&
      Number.isFinite(request.quantity) &&
      request.quantity! > 0 &&
      request.quantity === request.positionQuantity
    )
      return;
    throw new Error('STOP_COVERAGE_INVALID');
  }

  private async append(
    request: StopMutationRequest,
    event: JournalEventType,
    orderId?: string,
  ): Promise<JournalEntry> {
    try {
      return await this.journal!.append({
        id: randomUUID(),
        operationId: request.operationId,
        scope: request.scope,
        symbol: request.symbol,
        side: request.side,
        strategyId: request.strategyId,
        event,
        timestampMs: Date.now(),
        clientOrderId: request.clientOrderId,
        orderId,
        stopPrice: request.triggerPrice,
        quantity: request.positionQuantity,
        entryPrice: request.entryPrice,
        metadata: {
          request,
          journalOperationMeaning: 'STOP_MUTATION_NOT_TRADE',
          terminalMeaning: 'STOP_OBSERVED_NOT_POSITION_FLAT',
        },
      });
    } catch (error) {
      this.failure = `STOP_JOURNAL_BLOCKED:${String(error)}`;
      throw error;
    }
  }

  close(): Promise<void> {
    this.closing = true;
    return (this.closeTask ??= Promise.resolve().then(async () => {
      await this.startup?.catch(() => undefined);
      await Promise.allSettled([...this.tasks]);
      const failures: unknown[] = [];
      for (const operation of [() => this.journal?.flush(), () => this.journal?.close()]) {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      }
      if (this.failure) failures.push(new Error(this.failure));
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new RuntimeShutdownError(failures);
    }));
  }
}
