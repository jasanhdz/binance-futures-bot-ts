import { createHash, randomUUID } from 'node:crypto';
import type {
  ExecutionJournal,
  JournalEntry,
  JournalEventType,
  OperationScope,
} from '../../core/risk/ExecutionJournal';
import type { IdentifiedStopRequest, TradingExchangePort } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';

interface StopRetirement {
  protocol: 'STOP_RETIREMENT_V1';
  targetOperationId: string;
  request: StopMutationRequest;
  orderId: string;
  status: 'CANCELED';
  lastExitAt: number;
  flatObservedAt: number[];
}

export interface StopMutationRequest extends IdentifiedStopRequest {
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

function mutationDigest(scope: OperationScope, parentTradeId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.account, scope.environment, parentTradeId]))
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
      } catch (error) {
        this.failure = `STOP_JOURNAL_BLOCKED:${String(error)}`;
        throw error;
      }
    }));
  }

  blockedReason(): string | undefined {
    return this.failure ?? (this.pending.size ? 'STOP_MUTATION_PENDING' : undefined);
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
    const digest = mutationDigest(this.scope, snapshot.parentTradeId);
    const operationId = `stop:${digest}`;
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
          if (
            Object.entries(snapshot).some(
              ([key, value]) => request[key as keyof StopMutationRequest] !== value,
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
                order.closePosition === true,
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
          latest = await this.append(request, 'PREPARED');
          // Only the owner that created this durable PREPARED may submit, once.
          if (!samePosition() || this.closing) return false;
          const beforeSend = await this.deps.exchange
            .readActivePosition(request.symbol, request.side)
            .catch(() => null);
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
        const position = await this.deps.exchange
          .readActivePosition(request.symbol, request.side)
          .catch(() => null);
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
  reconcileClosed(stateForSymbol: (symbol: string) => StateStore): Promise<void> {
    if (this.retirementTask) return this.retirementTask;
    if (!this.journal || this.closing || this.failure) return Promise.resolve();
    const task = Promise.resolve()
      .then(async () => {
        const inventory = await this.journal!.listOperations();
        for (const id of new Set([
          ...this.pending,
          ...inventory.filter((key) => key.startsWith('stop:')),
        ])) {
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
                state.lastStrategy === request.strategyId &&
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
              const observed = await exchange.readStopCloseState(query);
              const last = history[history.length - 1];
              if (
                !observed ||
                observed.status !== 'CANCELED' ||
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
                status: 'CANCELED',
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
      proof.status !== 'CANCELED' ||
      typeof proof.orderId !== 'string' ||
      !proof.orderId.trim() ||
      (last.orderId && proof.orderId !== last.orderId) ||
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
      request.closePosition !== true ||
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
    const digest = mutationDigest(this.scope, request.parentTradeId);
    if (
      request.operationId !== `stop:${digest}` ||
      request.clientOrderId !== `bot_sl_${digest.slice(0, 28)}`
    )
      throw new Error('STOP_MUTATION_IDENTITY_CONFLICT');
    return request;
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
      try {
        await this.journal?.flush();
      } finally {
        await this.journal?.close();
      }
      if (this.failure) throw new Error(this.failure);
    }));
  }
}
