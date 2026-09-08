import { createHash, randomUUID } from 'node:crypto';
import type { BotState } from '../../core/types';
import type {
  ExecutionJournal,
  JournalEntry,
  JournalEventType,
  OperationScope,
} from '../../core/risk/ExecutionJournal';
import type { IdentifiedCloseRequest, IdentifiedClosePort, PositionInfo } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';
import type { PositionProtectionService } from '../position/PositionProtectionService';
import { RuntimeShutdownError } from '../runtime/RuntimeShutdown';
import { isMicroBurstTradePolicy } from '../../strategies/micro-burst/domain/MicroBurstTradePolicy';
import { validMicroBurstSettlementIdentity } from '../../strategies/micro-burst/domain/MicroBurstSettlement';

interface CloseRequest extends IdentifiedCloseRequest {
  protocol: 'MICRO_CLOSE_V1';
  scope: OperationScope;
  operationId: string;
  parentTradeId: string;
  parentOrderId: string;
  strategyId: 'MICRO_BURST_V1';
  entryPrice: number;
  identity: Pick<
    BotState,
    'mode' | 'lastEntryAt' | 'lastEntryQty' | 'lastEntryPrice' | 'ownershipStatus'
  >;
}

const closeReason = 'MICRO_IDENTIFIED_CLOSE_ACCOUNTING_PENDING';

function wireRequest(r: IdentifiedCloseRequest): IdentifiedCloseRequest {
  return {
    symbol: r.symbol,
    side: r.side,
    positionSide: r.positionSide,
    quantity: r.quantity,
    clientOrderId: r.clientOrderId,
    notBeforeMs: r.notBeforeMs,
  };
}

/** One immutable market-close attempt per managed parent. Recovery is observation-only. */
export class DurableCloseCoordinator {
  private journal?: ExecutionJournal;
  private startup?: Promise<void>;
  private closing = false;
  private closeTask?: Promise<void>;
  private failure?: string;
  private ready = false;
  private readonly busy = new Map<string, string>();
  private readonly pending = new Map<string, CloseRequest>();
  private readonly tasks = new Set<Promise<unknown>>();
  private recoveryTask?: Promise<void>;
  private readonly scope: OperationScope;

  constructor(
    private readonly deps: {
      scope: OperationScope;
      journal: () => ExecutionJournal;
      exchange: Partial<IdentifiedClosePort> & {
        readFreshActivePosition?(
          symbol: string,
          side: 'LONG' | 'SHORT',
        ): Promise<PositionInfo | null>;
      };
    },
  ) {
    this.scope = { ...deps.scope };
    if (!this.scope.account?.trim() || !this.scope.environment?.trim())
      throw new Error('CLOSE_SCOPE_REQUIRED');
  }

  private id(parent: string): string {
    return `close:${createHash('sha256')
      .update(JSON.stringify([this.scope.account, this.scope.environment, parent]))
      .digest('hex')}`;
  }

  blockedReason(): string | undefined {
    return (
      this.failure ??
      (!this.ready
        ? 'CLOSE_NOT_STARTED'
        : this.busy.size || this.pending.size
          ? 'CLOSE_MUTATION_PENDING'
          : undefined)
    );
  }

  blocksPosition(symbol: string, parent?: string): boolean {
    return (
      !!this.failure ||
      !this.ready ||
      [...this.busy.values()].includes(symbol) ||
      [...this.pending.values()].some((r) => r.symbol === symbol) ||
      (!!parent && (this.busy.has(this.id(parent)) || this.pending.has(this.id(parent))))
    );
  }

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('CLOSE_COORDINATOR_CLOSED'));
    return (this.startup ??= Promise.resolve().then(async () => {
      try {
        if (
          !this.deps.exchange.sendMarketCloseOnce ||
          !this.deps.exchange.readMarketCloseByClientOrderId ||
          !this.deps.exchange.readFreshActivePosition
        )
          throw new Error('IDENTIFIED_CLOSE_CAPABILITY_REQUIRED');
        this.journal = this.deps.journal();
        for (const id of await this.journal.listOperations()) {
          const history = await this.journal.read(id);
          const request = this.requestFrom(history[0]);
          for (const entry of history) {
            if (JSON.stringify(this.requestFrom(entry)) !== JSON.stringify(request))
              throw new Error('CLOSE_REQUEST_CHANGED');
          }
          if (history[history.length - 1].event !== 'CLOSED') this.pending.set(id, request);
        }
        this.ready = true;
      } catch (error) {
        this.failure = `CLOSE_JOURNAL_BLOCKED:${String(error)}`;
        throw error;
      }
    }));
  }

  private requestFrom(entry: JournalEntry): CloseRequest {
    const r = entry?.metadata?.request as CloseRequest | undefined;
    if (
      !r ||
      r.protocol !== 'MICRO_CLOSE_V1' ||
      r.scope.account !== this.scope.account ||
      r.scope.environment !== this.scope.environment ||
      r.operationId !== this.id(r.parentTradeId) ||
      r.clientOrderId !== `bot_cl_${r.operationId.slice(6, 34)}` ||
      !r.parentTradeId?.trim() ||
      !r.parentOrderId?.trim() ||
      !/^[A-Z0-9]+$/.test(r.symbol) ||
      r.strategyId !== 'MICRO_BURST_V1' ||
      !['LONG', 'SHORT'].includes(r.side) ||
      !['BOTH', r.side].includes(r.positionSide) ||
      !Number.isFinite(r.quantity) ||
      r.quantity <= 0 ||
      !Number.isFinite(r.entryPrice) ||
      r.entryPrice <= 0 ||
      !Number.isSafeInteger(r.notBeforeMs) ||
      r.notBeforeMs < 0 ||
      !r.identity ||
      r.identity.mode !== `${r.side}_RIDE` ||
      r.identity.lastEntryQty !== r.quantity ||
      r.identity.lastEntryPrice !== r.entryPrice ||
      entry.operationId !== r.operationId ||
      entry.symbol !== r.symbol ||
      entry.side !== r.side ||
      entry.strategyId !== r.strategyId ||
      entry.scope.account !== r.scope.account ||
      entry.scope.environment !== r.scope.environment ||
      entry.clientOrderId !== r.clientOrderId ||
      entry.quantity !== r.quantity ||
      entry.entryPrice !== r.entryPrice ||
      entry.metadata?.journalOperationMeaning !== 'CLOSE_MUTATION_NOT_TRADE'
    )
      throw new Error('CLOSE_JOURNAL_IDENTITY_INVALID');
    if (entry.event === 'CLOSED') {
      const proof = entry.metadata?.confirmation as Record<string, unknown> | undefined;
      if (
        !proof ||
        proof.source !== 'EXACT_MARKET_QUERY_AND_FRESH_FLAT' ||
        proof.status !== 'FILLED' ||
        proof.executedQuantity !== r.quantity ||
        typeof proof.orderId !== 'string' ||
        !/^[1-9]\d*$/.test(proof.orderId) ||
        !Number.isSafeInteger(Number(proof.orderId)) ||
        !Number.isSafeInteger(proof.observedAt) ||
        Number(proof.observedAt) < r.notBeforeMs ||
        proof.accounting !== 'UNVERIFIED'
      )
        throw new Error('CLOSE_TERMINAL_EVIDENCE_INVALID');
    }
    return r;
  }

  private same(r: CloseRequest, store: StateStore, allowClosed = false): boolean {
    const s = store.get();
    return (
      s.positionOwner === 'BOT' &&
      s.lastTradeId === r.parentTradeId &&
      s.lastOrderId === r.parentOrderId &&
      s.lastSide === r.side &&
      s.lastStrategy === r.strategyId &&
      (['lastEntryAt', 'lastEntryQty', 'lastEntryPrice', 'ownershipStatus'] as const).every(
        (key) => s[key] === r.identity[key],
      ) &&
      (s.mode === r.identity.mode ||
        (allowClosed &&
          s.mode === 'IDLE' &&
          s.lastExitReason === closeReason &&
          s.microBurstPnlUnverified === true &&
          Number.isSafeInteger(s.lastExitAt) &&
          s.lastExitAt! >= r.notBeforeMs))
    );
  }

  private async append(
    r: CloseRequest,
    event: JournalEventType,
    extra: Record<string, unknown> = {},
  ): Promise<JournalEntry> {
    const entry = await this.journal!.append({
      id: randomUUID(),
      operationId: r.operationId,
      scope: r.scope,
      symbol: r.symbol,
      side: r.side,
      strategyId: r.strategyId,
      clientOrderId: r.clientOrderId,
      quantity: r.quantity,
      entryPrice: r.entryPrice,
      event,
      timestampMs: Date.now(),
      metadata: { request: r, journalOperationMeaning: 'CLOSE_MUTATION_NOT_TRADE', ...extra },
    });
    await this.journal!.flush();
    return entry;
  }

  closeManaged(
    symbol: string,
    store: StateStore,
    protection: PositionProtectionService,
    expected: BotState = store.get(),
  ): Promise<boolean> {
    // Copy identity and acquire exclusion before the first await, including the initial fresh read.
    const state = { ...expected };
    if (
      this.closing ||
      this.failure ||
      !/^[A-Z0-9]+$/.test(symbol) ||
      state.positionOwner !== 'BOT' ||
      state.lastStrategy !== 'MICRO_BURST_V1' ||
      !state.lastTradeId ||
      !state.lastOrderId ||
      !state.lastSide ||
      state.mode !== `${state.lastSide}_RIDE` ||
      !store.flush
    )
      return Promise.resolve(false);
    const id = this.id(state.lastTradeId);
    if (
      this.busy.size ||
      [...this.pending.values()].some((r) => r.symbol === symbol && r.operationId !== id)
    )
      return Promise.resolve(false);
    this.busy.set(id, symbol);
    return this.track(id, async () => {
      await this.start();
      if ([...this.pending.values()].some((r) => r.symbol === symbol && r.operationId !== id))
        return false;
      const saved = await this.journal!.readLatest(id);
      if (saved) {
        const r = this.requestFrom(saved);
        if (r.symbol !== symbol || !this.same(r, store)) return false;
        return this.observe(r, store, protection);
      }
      let position: PositionInfo | null;
      try {
        position = await this.deps.exchange.readFreshActivePosition!(symbol, state.lastSide!);
      } catch {
        // No mutation is prepared yet; an observation failure must not disable supervision.
        return false;
      }
      if (!position) return false; // Flat without an identified fill is not our close.
      const r: CloseRequest = {
        protocol: 'MICRO_CLOSE_V1',
        scope: this.scope,
        operationId: id,
        clientOrderId: `bot_cl_${id.slice(6, 34)}`,
        symbol,
        side: state.lastSide!,
        positionSide: position.sideMode,
        quantity: position.qtyAbs,
        entryPrice: position.entryPrice,
        notBeforeMs: Date.now(),
        parentTradeId: state.lastTradeId!,
        parentOrderId: state.lastOrderId!,
        strategyId: 'MICRO_BURST_V1',
        identity: JSON.parse(
          JSON.stringify({
            mode: state.mode,
            lastEntryAt: state.lastEntryAt,
            lastEntryQty: state.lastEntryQty,
            lastEntryPrice: state.lastEntryPrice,
            ownershipStatus: state.ownershipStatus,
          }),
        ),
      };
      if (
        !this.same(r, store) ||
        !['BOTH', r.side].includes(r.positionSide) ||
        !Number.isFinite(r.quantity) ||
        r.quantity <= 0 ||
        !Number.isFinite(r.entryPrice) ||
        r.entryPrice <= 0 ||
        r.entryPrice !== state.lastEntryPrice ||
        r.quantity !== state.lastEntryQty ||
        this.closing
      )
        return false;
      this.pending.set(id, r);
      store.set({
        microProtectionBlocked: true,
        microBurstPnlUnverified: true,
        microBurstPnlUnverifiedAt: state.microBurstPnlUnverifiedAt ?? Date.now(),
      });
      await store.flush!();
      await this.append(r, 'PREPARED');
      if (!this.same(r, store) || this.closing) return false;
      const fresh = await this.deps.exchange.readFreshActivePosition!(symbol, r.side);
      if (
        !this.same(r, store) ||
        this.closing ||
        !fresh ||
        fresh.qtyAbs !== r.quantity ||
        fresh.entryPrice !== r.entryPrice ||
        fresh.sideMode !== r.positionSide
      )
        return false;
      try {
        await this.deps.exchange.sendMarketCloseOnce!(wireRequest(r));
      } catch {
        /* Lost ACK is observation-only. */
      }
      await this.append(r, 'UNKNOWN');
      return this.observe(r, store, protection);
    });
  }

  private track(id: string, work: () => Promise<boolean>): Promise<boolean> {
    const task = Promise.resolve()
      .then(work)
      .catch((error) => {
        this.failure = `CLOSE_RECOVERY_BLOCKED:${String(error)}`;
        return false;
      })
      .finally(() => {
        this.busy.delete(id);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    return task;
  }

  private async observe(
    r: CloseRequest,
    store: StateStore,
    protection: PositionProtectionService,
  ): Promise<boolean> {
    if (!this.same(r, store, true) || !store.flush) return false;
    const latest = (await this.journal!.readLatest(r.operationId))!;
    if (!this.same(r, store, true)) return false;
    if (latest.event === 'CLOSED') return false;
    if (latest.metadata?.quarantine) return false;
    store.set({
      microProtectionBlocked: true,
      microBurstPnlUnverified: true,
      microBurstPnlUnverifiedAt: store.get().microBurstPnlUnverifiedAt ?? Date.now(),
    });
    await store.flush();
    const evidence = await this.deps.exchange.readMarketCloseByClientOrderId!(wireRequest(r)).catch(
      () => null,
    );
    if (
      !evidence ||
      evidence.clientOrderId !== r.clientOrderId ||
      !/^[1-9]\d*$/.test(evidence.orderId) ||
      !Number.isSafeInteger(Number(evidence.orderId)) ||
      !this.same(r, store, true)
    )
      return false;
    if (
      evidence.status === 'PARTIALLY_FILLED' ||
      (evidence.executedQuantity > 0 && evidence.executedQuantity !== r.quantity)
    ) {
      await this.append(r, 'RECOVERY_REQUIRED', { quarantine: 'PARTIAL_CLOSE_NO_RETRY' });
      return false;
    }
    if (evidence.status !== 'FILLED' || evidence.executedQuantity !== r.quantity) return false;
    for (let i = 0; i < 2; i++) {
      const fresh = await this.deps.exchange.readFreshActivePosition!(r.symbol, r.side).catch(
        () => undefined,
      );
      if (fresh !== null) {
        if (fresh)
          await this.append(r, 'RECOVERY_REQUIRED', { quarantine: 'RESIDUAL_AFTER_FILL_NO_RETRY' });
        return false;
      }
      if (!this.same(r, store, true)) return false;
    }
    const identity = { ...store.get() };
    if (
      !(await protection.cleanupMicroCloseOrders(r.symbol, store, identity)) ||
      !this.same(r, store, true)
    )
      return false;
    const finalPosition = await this.deps.exchange.readFreshActivePosition!(r.symbol, r.side);
    if (finalPosition !== null) {
      await this.append(r, 'RECOVERY_REQUIRED', { quarantine: 'RESIDUAL_AFTER_FILL_NO_RETRY' });
      return false;
    }
    if (!this.same(r, store, true)) return false;
    if (identity.lastStrategyVersion === 'CONTEXTUAL_V3' && !identity.microBurstSettlement) {
      const policy = identity.microBurstTradePolicy;
      const settlement = {
        tradeId: r.parentTradeId,
        episodeId: identity.microBurstEpisodeId ?? '',
        symbol: r.symbol,
        side: r.side,
        policyVersion: 'CONTEXTUAL_V3' as const,
        configHash: identity.lastConfigHash ?? '',
        codeCommitSha: identity.lastCodeCommitSha ?? '',
        entryOrderId: r.parentOrderId,
        closeOrderIds: [evidence.orderId],
        quantity: r.quantity,
        openedAtMs: identity.microBurstEntrySubmittedAtMs ?? NaN,
        closedAtMs: Date.now(),
      };
      if (
        isMicroBurstTradePolicy(policy, {
          strategyId: r.strategyId,
          strategyVersion: 'CONTEXTUAL_V3',
          configHash: identity.lastConfigHash,
          codeCommitSha: identity.lastCodeCommitSha ?? '',
        }) &&
        validMicroBurstSettlementIdentity(settlement)
      ) {
        // Persist accounting recovery before the close journal can become terminal.
        store.set({ microBurstSettlement: settlement });
        await store.flush();
        if (!this.same(r, store, true)) return false;
      }
    }
    if (
      !(await protection.persistMicroOperationalClose(store, identity, {
        lastExitAt: identity.mode === 'IDLE' ? identity.lastExitAt : Date.now(),
        lastExitReason: closeReason,
        microBurstPnlUnverified: true,
        microBurstPnlUnverifiedAt: identity.microBurstPnlUnverifiedAt ?? Date.now(),
      })) ||
      !this.same(r, store, true)
    )
      return false;
    const confirmation = {
      source: 'EXACT_MARKET_QUERY_AND_FRESH_FLAT',
      status: 'FILLED',
      orderId: evidence.orderId,
      executedQuantity: evidence.executedQuantity,
      observedAt: Date.now(),
      accounting: 'UNVERIFIED',
    };
    if (latest.event !== 'CLOSE_PENDING') await this.append(r, 'CLOSE_PENDING', { confirmation });
    await this.append(r, 'CLOSED', { confirmation });
    this.pending.delete(r.operationId);
    return true;
  }

  reconcile(
    storeFor: (symbol: string) => StateStore,
    protection: PositionProtectionService,
  ): Promise<void> {
    if (this.closing || this.failure) return Promise.resolve();
    if (this.recoveryTask) return this.recoveryTask;
    const task = Promise.resolve()
      .then(async () => {
        await this.start();
        for (const [id, r] of this.pending) {
          if (this.closing || [...this.busy.values()].includes(r.symbol)) continue;
          this.busy.set(id, r.symbol);
          await this.track(id, () => this.observe(r, storeFor(r.symbol), protection));
        }
      })
      .catch((error) => {
        this.failure = `CLOSE_RECOVERY_BLOCKED:${String(error)}`;
      })
      .finally(() => {
        this.recoveryTask = undefined;
        this.tasks.delete(task);
      });
    this.recoveryTask = task;
    this.tasks.add(task);
    return task;
  }

  close(): Promise<void> {
    this.closing = true;
    return (this.closeTask ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      try {
        await this.startup;
      } catch (error) {
        failures.push(error);
      }
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      for (const work of [() => this.journal?.flush(), () => this.journal?.close()]) {
        try {
          await work();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new RuntimeShutdownError(failures);
    }));
  }
}
