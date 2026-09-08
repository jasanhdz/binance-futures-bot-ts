import { createHash, randomUUID } from 'node:crypto';
import type {
  ExecutionJournal,
  JournalEntry,
  JournalEventType,
  OperationScope,
} from '../../core/risk/ExecutionJournal';
import type { StrategyExecutionIntent } from '../../core/strategy/StrategyExecution';
import { isMicroBurstTradePolicy } from '../../strategies/micro-burst/domain/MicroBurstTradePolicy';

export interface DurableEntryRequest {
  protocol: 'ENTRY_MUTATION_V1';
  scope: OperationScope;
  operationId: string;
  mutationId: string;
  kind: 'OPEN';
  parentTradeId: string;
  intent: StrategyExecutionIntent;
  quantity: number;
  clientOrderId: string;
}

export interface EntryOrderReceipt {
  avgPrice: number;
  orderId: string;
}

export type DurableEntryResult = {
  operationId: string;
  mutationId: string;
} & (
  | { status: 'CONFIRMED'; order: EntryOrderReceipt }
  | { status: 'REJECTED'; code: number }
  | { status: 'UNKNOWN' | 'BLOCKED'; reason: string }
);

type TerminalEvidence =
  | { status: 'CONFIRMED'; order: EntryOrderReceipt }
  | { status: 'REJECTED'; code: number };

export interface DurableEntryCoordinatorDeps {
  scope: OperationScope;
  journal: () => ExecutionJournal;
  lookup: (request: DurableEntryRequest) => Promise<EntryOrderReceipt | null>;
  /** Confirms ownership/protection were handed to a durable position projection. */
  confirmHandoff: (request: DurableEntryRequest, order: EntryOrderReceipt) => Promise<boolean>;
}

/** One journal operation is ONE entry mutation, never a position/trade lifecycle.
 * CLOSED means the mutation's outcome is durable, not that a position is flat.
 * Only the live owner of a newly persisted PREPARED record may send it once.
 */
export class DurableEntryCoordinator {
  private journal?: ExecutionJournal;
  private initialized = false;
  private stopping = false;
  private failure?: string;
  private readonly pending = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private recovery?: Promise<void>;
  private startup?: Promise<void>;
  private shutdown?: Promise<void>;
  private readonly scope: OperationScope;
  private recoverPosition?: (
    request: DurableEntryRequest,
    order: EntryOrderReceipt,
  ) => Promise<void>;

  constructor(private readonly deps: DurableEntryCoordinatorDeps) {
    this.scope = { ...deps.scope };
  }

  /** Bound once by TradingService to its existing state/protection services, before start. */
  registerPositionRecovery(
    handler: (request: DurableEntryRequest, order: EntryOrderReceipt) => Promise<void>,
  ): void {
    if (this.startup || this.stopping || this.recoverPosition)
      throw new Error('ENTRY_RECOVERY_HANDLER_ALREADY_BOUND');
    this.recoverPosition = handler;
  }

  blockedReason(): string | undefined {
    if (this.stopping) return 'ENTRY_COORDINATOR_STOPPING';
    if (this.failure) return this.failure;
    if (!this.initialized) return 'ENTRY_RECOVERY_NOT_INITIALIZED';
    if (this.pending.size) return 'ENTRY_MUTATION_PENDING';
    return undefined;
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('ENTRY_COORDINATOR_STOPPING'));
    if (this.startup) return this.startup;
    this.startup = (async () => {
      try {
        this.journal = this.deps.journal();
        for (const id of await this.journal.listNonTerminal()) this.pending.add(id);
        await this.reconcile();
        if (this.failure) throw new Error(this.failure);
        this.initialized = true;
      } catch (error) {
        this.failure ??= 'ENTRY_JOURNAL_UNAVAILABLE';
        throw error;
      }
    })();
    return this.startup;
  }

  execute(
    intent: StrategyExecutionIntent,
    quantity: number,
    clientOrderId: string,
    send: (request: DurableEntryRequest) => Promise<EntryOrderReceipt>,
    isCurrent: () => boolean = () => true,
  ): Promise<DurableEntryResult> {
    const contextual =
      intent.identity.strategyId === 'MICRO_BURST_V1' &&
      intent.identity.strategyVersion === 'CONTEXTUAL_V3';
    const episodeId = intent.metadata.episodeId;
    const operationId = `entry_${createHash('sha256')
      .update(
        JSON.stringify(
          contextual
            ? [
                this.scope.account,
                this.scope.environment,
                'MICRO_CONTEXTUAL_EPISODE_V3',
                intent.symbol,
                intent.side,
                episodeId,
              ]
            : [this.scope, intent.tradeId, clientOrderId],
        ),
      )
      .digest('hex')}`;
    const identity = { operationId, mutationId: clientOrderId };
    if (contextual && (typeof episodeId !== 'string' || !/^MBV1-EP-[a-f0-9]{24}$/.test(episodeId)))
      return Promise.resolve({
        ...identity,
        status: 'BLOCKED',
        reason: 'MICRO_DURABLE_EPISODE_REQUIRED',
      });
    const policy = intent.metadata.contextualPolicy;
    if (
      contextual &&
      (!isMicroBurstTradePolicy(policy, intent.identity) ||
        ![20, 30].includes(intent.leverage) ||
        intent.leverage > policy.config.maxLeverageHardCap ||
        intent.positionFraction !== policy.risk.marginFraction)
    )
      return Promise.resolve({
        ...identity,
        status: 'BLOCKED',
        reason: 'MICRO_TRADE_POLICY_INVALID',
      });
    const blocked = this.blockedReason();
    if (blocked) return Promise.resolve({ ...identity, status: 'BLOCKED', reason: blocked });
    let request: DurableEntryRequest;
    try {
      if (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !/^[.A-Z\/:a-z0-9_-]{1,36}$/.test(clientOrderId)
      )
        throw new Error('ENTRY_REQUEST_INVALID');
      request = jsonSnapshot({
        protocol: 'ENTRY_MUTATION_V1',
        scope: this.scope,
        ...identity,
        kind: 'OPEN',
        parentTradeId: intent.tradeId,
        intent,
        quantity,
        clientOrderId,
      }) as DurableEntryRequest;
    } catch {
      return Promise.resolve({ ...identity, status: 'BLOCKED', reason: 'ENTRY_REQUEST_INVALID' });
    }
    const current = () =>
      isCurrent() && JSON.stringify(jsonSnapshot(intent)) === JSON.stringify(request.intent);
    // Reserve synchronously, before reads/awaits, across every strategy and symbol.
    this.pending.add(operationId);
    return this.track(async (): Promise<DurableEntryResult> => {
      try {
        if (await this.journal!.readLatest(operationId)) {
          this.pending.delete(operationId);
          return { ...identity, status: 'BLOCKED', reason: 'ENTRY_MUTATION_ALREADY_RECORDED' };
        }
        if (this.stopping || !current()) {
          this.pending.delete(operationId);
          return { ...identity, status: 'BLOCKED', reason: 'ENTRY_IDENTITY_NOT_CURRENT' };
        }
        await this.append(request, 'PREPARED');
        await this.journal!.flush();
        // A change during persistence must not turn a stale intent into a send.
        if (this.stopping || !current()) {
          await this.append(request, 'RECOVERY_REQUIRED', undefined, 'ENTRY_IDENTITY_NOT_CURRENT');
          return { ...identity, status: 'BLOCKED', reason: 'ENTRY_IDENTITY_NOT_CURRENT' };
        }
        let evidence: TerminalEvidence;
        try {
          const order = await send(jsonSnapshot(request) as DurableEntryRequest);
          if (!validOrder(order)) throw new Error('ENTRY_ACK_INVALID');
          evidence = { status: 'CONFIRMED', order: { ...order } };
        } catch (error) {
          const code = definiteEntryRejectionCode(error);
          if (code === undefined) {
            await this.append(request, 'UNKNOWN', undefined, 'ENTRY_SEND_UNKNOWN');
            // No resend, even if exact lookup is unavailable or returns -2013.
            const order = await this.lookup(request);
            if (!order) return { ...identity, status: 'UNKNOWN', reason: 'ENTRY_SEND_UNKNOWN' };
            evidence = { status: 'CONFIRMED', order };
          } else {
            evidence = { status: 'REJECTED', code };
          }
        }
        await this.finish(request, evidence);
        if ((await this.journal!.readLatest(operationId))?.event === 'CLOSED')
          this.pending.delete(operationId);
        return { ...identity, ...evidence };
      } catch {
        // An ACK whose append failed is not a durable success. Keep the reservation.
        this.failure = 'ENTRY_JOURNAL_UNCERTAIN';
        return { ...identity, status: 'UNKNOWN', reason: this.failure };
      }
    });
  }

  /** Keep reconstruction out of Shared's receipt/protection/emergency handling.
   * This is a live exclusion only, not durable transfer or permission to settle entry.
   */
  withLiveHandoff<T>(work: () => Promise<T>): Promise<T> {
    const recovery = this.recovery;
    return this.track(async () => {
      // A recovery already reading evidence must finish before a new live owner starts.
      await recovery;
      return work();
    });
  }

  reconcile(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (!this.journal || this.stopping || this.failure) return Promise.resolve();
    // Includes the live Shared owner, not just the nested entry transport task.
    if (this.tasks.size) return Promise.resolve();
    this.recovery = this.track(async () => {
      try {
        for (const operationId of [...this.pending]) {
          const latest = await this.journal!.readLatest(operationId);
          if (!latest) throw new Error('ENTRY_PENDING_RECORD_MISSING');
          const request = this.requestFrom(latest);
          const persisted = latest.metadata?.outcome as TerminalEvidence | undefined;
          if (
            persisted?.status === 'REJECTED' &&
            definiteEntryRejectionCode(persisted) !== undefined
          ) {
            await this.finish(request, persisted);
            if ((await this.journal!.readLatest(operationId))?.event === 'CLOSED')
              this.pending.delete(operationId);
            continue;
          }
          if (persisted?.status === 'CONFIRMED' && validOrder(persisted.order)) {
            await this.finish(request, persisted, true);
            if ((await this.journal!.readLatest(operationId))?.event === 'CLOSED')
              this.pending.delete(operationId);
            continue;
          }
          const order = await this.lookup(request);
          if (order) {
            await this.finish(request, { status: 'CONFIRMED', order }, true);
            if ((await this.journal!.readLatest(operationId))?.event === 'CLOSED')
              this.pending.delete(operationId);
          } else if (latest.event === 'PREPARED' || latest.event === 'SUBMITTED') {
            await this.append(request, 'UNKNOWN', undefined, 'ENTRY_RECOVERY_LOOKUP_UNKNOWN');
          }
        }
      } catch {
        this.failure = 'ENTRY_RECOVERY_JOURNAL_UNCERTAIN';
      }
    }).finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    this.shutdown = (async () => {
      await this.startup?.catch(() => undefined);
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      if (this.journal) {
        try {
          await this.journal.flush();
        } finally {
          await this.journal.close();
        }
      }
      if (this.failure) throw new Error(this.failure);
    })();
    return this.shutdown;
  }

  private async lookup(request: DurableEntryRequest): Promise<EntryOrderReceipt | null> {
    try {
      const order = await this.deps.lookup(jsonSnapshot(request) as DurableEntryRequest);
      return validOrder(order) ? { ...order } : null;
    } catch {
      return null;
    }
  }

  private requestFrom(entry: JournalEntry): DurableEntryRequest {
    const request = entry.metadata?.request as DurableEntryRequest | undefined;
    if (
      entry.metadata?.journalOperationMeaning !== 'ENTRY_MUTATION_NOT_TRADE' ||
      request?.protocol !== 'ENTRY_MUTATION_V1' ||
      request.kind !== 'OPEN' ||
      request.scope.account !== this.scope.account ||
      request.scope.environment !== this.scope.environment ||
      entry.scope.account !== this.scope.account ||
      entry.scope.environment !== this.scope.environment ||
      request.operationId !== entry.operationId ||
      request.mutationId !== entry.clientOrderId ||
      request.clientOrderId !== entry.clientOrderId ||
      request.quantity !== entry.quantity ||
      request.intent.symbol !== entry.symbol ||
      request.intent.side !== entry.side ||
      request.intent.identity.strategyId !== entry.strategyId ||
      request.parentTradeId !== request.intent.tradeId
    )
      throw new Error('ENTRY_RECOVERY_IDENTITY_CONFLICT');
    if (
      request.intent.identity.strategyId === 'MICRO_BURST_V1' &&
      request.intent.identity.strategyVersion === 'CONTEXTUAL_V3'
    ) {
      const episodeId = request.intent.metadata.episodeId;
      const expected = `entry_${createHash('sha256')
        .update(
          JSON.stringify([
            this.scope.account,
            this.scope.environment,
            'MICRO_CONTEXTUAL_EPISODE_V3',
            request.intent.symbol,
            request.intent.side,
            episodeId,
          ]),
        )
        .digest('hex')}`;
      if (
        typeof episodeId !== 'string' ||
        !/^MBV1-EP-[a-f0-9]{24}$/.test(episodeId) ||
        request.operationId !== expected ||
        !isMicroBurstTradePolicy(request.intent.metadata.contextualPolicy, request.intent.identity)
      )
        throw new Error('MICRO_DURABLE_EPISODE_CONFLICT');
    }
    return request;
  }

  private async finish(
    request: DurableEntryRequest,
    outcome: TerminalEvidence,
    recovery = false,
  ): Promise<void> {
    let event = (await this.journal!.readLatest(request.operationId))!.event;
    if (outcome.status === 'CONFIRMED' && event !== 'CLOSE_PENDING' && event !== 'CLOSED') {
      if (event === 'PREPARED') {
        await this.append(request, 'SUBMITTED', outcome);
        event = 'SUBMITTED';
      }
      if (event !== 'OPEN_CONFIRMED') await this.append(request, 'OPEN_CONFIRMED', outcome);
    }
    if (outcome.status === 'CONFIRMED' && event !== 'CLOSED') {
      let handedOff = false;
      try {
        // Never run reconstruction while Shared is still handling a live execute() receipt.
        if (recovery && !this.stopping) {
          await this.recoverPosition?.(jsonSnapshot(request) as DurableEntryRequest, {
            ...outcome.order,
          });
        }
        handedOff = await this.deps.confirmHandoff(request, outcome.order);
      } catch {
        /* Keep recovery pending. */
      }
      if (!handedOff) return;
    }
    if (event !== 'CLOSE_PENDING' && event !== 'CLOSED')
      await this.append(request, 'CLOSE_PENDING', outcome);
    if (event !== 'CLOSED') await this.append(request, 'CLOSED', outcome);
  }

  private async append(
    request: DurableEntryRequest,
    event: JournalEventType,
    outcome?: TerminalEvidence,
    reason?: string,
  ): Promise<void> {
    await this.journal!.append({
      id: randomUUID(),
      operationId: request.operationId,
      scope: this.scope,
      symbol: request.intent.symbol,
      side: request.intent.side,
      strategyId: request.intent.identity.strategyId,
      clientOrderId: request.clientOrderId,
      quantity: request.quantity,
      leverage: request.intent.leverage,
      event,
      timestampMs: Date.now(),
      reason: reason ?? (outcome ? `ENTRY_MUTATION_${outcome.status}` : 'ENTRY_MUTATION_PREPARED'),
      metadata: {
        journalOperationMeaning: 'ENTRY_MUTATION_NOT_TRADE',
        request,
        ...(outcome ? { outcome } : {}),
      },
    });
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(work);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
}

export function definiteEntryRejectionCode(error: unknown): number | undefined {
  const value = error as {
    code?: unknown;
    response?: { data?: { code?: unknown } };
    body?: { code?: unknown };
  };
  const codes = [value?.code, value?.response?.data?.code, value?.body?.code].filter(
    (code): code is number => typeof code === 'number',
  );
  // Conflicting codes and uncoded prose are uncertainty, not permission to retry.
  if (!codes.length || codes.some((code) => code !== codes[0])) return undefined;
  return [-1111, -2010, -2018, -2019, -2027, -4003, -4004, -4005].includes(codes[0])
    ? codes[0]
    : undefined;
}

function validOrder(value: EntryOrderReceipt | null | undefined): value is EntryOrderReceipt {
  return (
    !!value &&
    typeof value.orderId === 'string' &&
    !!value.orderId.trim() &&
    Number.isFinite(value.avgPrice) &&
    value.avgPrice > 0
  );
}

function jsonSnapshot(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonSnapshot);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('ENTRY_REQUEST_NOT_JSON');
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) throw new Error('ENTRY_REQUEST_ACCESSOR');
        return descriptor.value === undefined ? [] : [[key, jsonSnapshot(descriptor.value)]];
      }),
  );
}
