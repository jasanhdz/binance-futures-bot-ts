import crypto from 'node:crypto';

export type DurableExecutionState =
  | 'INTENT_CREATED'
  | 'ORDER_SUBMITTING'
  | 'ORDER_SUBMITTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'PROTECTION_PENDING'
  | 'PROTECTED'
  | 'EXIT_PENDING'
  | 'CLOSED'
  | 'RECONCILIATION_REQUIRED'
  | 'FAILED_CLOSED';

export type EntryOrderStatus =
  | 'NOT_FOUND'
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED';

export interface DurableEntryIntent {
  intentId: string;
  signalId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  expectedPrice: number;
  policyId: string;
  featureHash: string;
  createdAt: string;
  clientOrderId: string;
  closeClientOrderId: string;
  protectionPolicy: DurableProtectionPolicy;
}

export interface DurableProtectionPolicy {
  stopRoe: number;
  takeProfitRoe: number;
  leverage: number;
  pricePrecision: number;
}

export interface ProtectionPlan {
  stopPrice: number;
  takeProfitPrice: number;
}

export interface EntryOrderTruth {
  status: EntryOrderStatus;
  clientOrderId: string;
  exchangeOrderId?: string;
  originalQuantity: number;
  executedQuantity: number;
  averagePrice?: number;
}

export interface PositionTruth {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
}

export interface ProtectionTruth {
  stopPresent: boolean;
  takeProfitPresent: boolean;
  protectedQuantity: number;
  stopPrice?: number;
  takeProfitPrice?: number;
}

export interface ExecutionTruth {
  order: EntryOrderTruth;
  fillsQuantity: number;
  position: PositionTruth | null;
  protection: ProtectionTruth;
  closeOrderFound: boolean;
  conclusive: boolean;
}

export interface DurableExecutionRecord {
  schemaVersion: 'aegis-durable-execution-lifecycle-v1';
  revision: number;
  intent: DurableEntryIntent;
  state: DurableExecutionState;
  entryStatus: EntryOrderStatus;
  exchangeOrderId?: string;
  filledQuantity: number;
  averagePrice?: number;
  protection?: ProtectionTruth;
  retryAuthorized: boolean;
  lastReason: string;
  updatedAt: string;
}

export interface DurableExecutionStore {
  get(intentId: string): DurableExecutionRecord | null;
  put(record: DurableExecutionRecord, expectedRevision: number | null): void;
  listNonTerminal(): DurableExecutionRecord[];
}

export interface DurableExecutionExchange {
  submitEntry(intent: DurableEntryIntent): Promise<void>;
  readTruth(intent: DurableEntryIntent): Promise<ExecutionTruth>;
  ensureProtection(
    intent: DurableEntryIntent,
    position: PositionTruth,
    plan: ProtectionPlan,
  ): Promise<ProtectionTruth>;
  submitReduceOnlyClose(intent: DurableEntryIntent, position: PositionTruth): Promise<void>;
  discoverUnmanagedPositions(): Promise<PositionTruth[]>;
}

export class AmbiguousExchangeResult extends Error {}
export class DefinitiveExchangeRejection extends Error {}
export class DurableExecutionError extends Error {}

const TERMINAL = new Set<DurableExecutionState>(['CLOSED', 'FAILED_CLOSED']);

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new DurableExecutionError(`${name}_INVALID`);
  return value;
}

function canonicalIntentMaterial(
  input: Omit<DurableEntryIntent, 'intentId' | 'clientOrderId' | 'closeClientOrderId'>,
): string {
  return JSON.stringify([
    input.signalId,
    input.symbol,
    input.side,
    input.quantity,
    input.expectedPrice,
    input.policyId,
    input.featureHash,
    input.protectionPolicy,
  ]);
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function createDurableEntryIntent(
  input: Omit<DurableEntryIntent, 'intentId' | 'clientOrderId' | 'closeClientOrderId'>,
): DurableEntryIntent {
  finitePositive(input.quantity, 'INTENT_QUANTITY');
  finitePositive(input.expectedPrice, 'INTENT_EXPECTED_PRICE');
  finitePositive(input.protectionPolicy.leverage, 'PROTECTION_LEVERAGE');
  if (
    !Number.isFinite(input.protectionPolicy.stopRoe) ||
    !Number.isFinite(input.protectionPolicy.takeProfitRoe) ||
    !Number.isInteger(input.protectionPolicy.pricePrecision) ||
    input.protectionPolicy.pricePrecision < 0
  ) {
    throw new DurableExecutionError('PROTECTION_POLICY_INVALID');
  }
  if (
    !/^[A-Z0-9]{5,20}$/.test(input.symbol) ||
    !input.signalId ||
    !input.policyId ||
    !input.featureHash
  ) {
    throw new DurableExecutionError('INTENT_IDENTITY_INVALID');
  }
  const digest = shortHash(canonicalIntentMaterial(input));
  return {
    ...input,
    intentId: `entry:${digest}`,
    clientOrderId: `aegis-e-${digest}`,
    closeClientOrderId: `aegis-x-${digest}`,
  };
}

export function buildProtectionPlan(
  intent: DurableEntryIntent,
  position: PositionTruth,
): ProtectionPlan {
  const { stopRoe, takeProfitRoe, leverage, pricePrecision } = intent.protectionPolicy;
  const price = (roe: number, kind: 'STOP' | 'TP'): number => {
    const move = Math.abs(roe) / leverage;
    if (kind === 'STOP') {
      return intent.side === 'LONG'
        ? position.entryPrice * (1 - move)
        : position.entryPrice * (1 + move);
    }
    return intent.side === 'LONG'
      ? position.entryPrice * (1 + move)
      : position.entryPrice * (1 - move);
  };
  return {
    stopPrice: Number(price(stopRoe, 'STOP').toFixed(pricePrecision)),
    takeProfitPrice: Number(price(takeProfitRoe, 'TP').toFixed(pricePrecision)),
  };
}

export class DurableExecutionCoordinator {
  constructor(
    private readonly store: DurableExecutionStore,
    private readonly exchange: DurableExecutionExchange,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  prepare(intent: DurableEntryIntent): DurableExecutionRecord {
    const existing = this.store.get(intent.intentId);
    if (existing) {
      if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
        throw new DurableExecutionError('INTENT_IDENTITY_CONFLICT');
      }
      return existing;
    }
    const record: DurableExecutionRecord = {
      schemaVersion: 'aegis-durable-execution-lifecycle-v1',
      revision: 1,
      intent,
      state: 'INTENT_CREATED',
      entryStatus: 'NOT_FOUND',
      filledQuantity: 0,
      retryAuthorized: false,
      lastReason: 'INTENT_DURABLY_CREATED',
      updatedAt: this.now(),
    };
    this.store.put(record, null);
    return record;
  }

  async submit(intent: DurableEntryIntent): Promise<DurableExecutionRecord> {
    let record = this.prepare(intent);
    if (TERMINAL.has(record.state) || record.state === 'PROTECTED') return record;
    if (!['INTENT_CREATED', 'RECONCILIATION_REQUIRED'].includes(record.state)) {
      return this.reconcile(intent);
    }
    if (record.state === 'RECONCILIATION_REQUIRED' && !record.retryAuthorized) {
      return this.reconcile(intent);
    }
    record = this.transition(record, {
      state: 'ORDER_SUBMITTING',
      retryAuthorized: false,
      lastReason: 'ENTRY_REQUEST_DURABLY_JOURNALED',
    });
    try {
      await this.exchange.submitEntry(intent);
    } catch (error) {
      if (error instanceof DefinitiveExchangeRejection) {
        return this.transition(record, {
          state: 'FAILED_CLOSED',
          entryStatus: 'REJECTED',
          lastReason: 'ENTRY_DEFINITIVELY_REJECTED',
        });
      }
      record = this.transition(record, {
        state: 'RECONCILIATION_REQUIRED',
        lastReason:
          error instanceof AmbiguousExchangeResult
            ? 'ENTRY_ACKNOWLEDGEMENT_AMBIGUOUS'
            : 'ENTRY_TRANSPORT_RESULT_UNKNOWN',
      });
      return this.reconcile(intent);
    }
    record = this.transition(record, {
      state: 'ORDER_SUBMITTED',
      lastReason: 'ENTRY_TRANSPORT_ACKNOWLEDGED',
    });
    return this.reconcile(intent);
  }

  async reconcile(intent: DurableEntryIntent): Promise<DurableExecutionRecord> {
    let record = this.prepare(intent);
    const truth = await this.exchange.readTruth(intent);
    if (!truth.conclusive) {
      return this.transition(record, {
        state: 'RECONCILIATION_REQUIRED',
        retryAuthorized: false,
        lastReason: 'EXCHANGE_TRUTH_INCOMPLETE',
      });
    }
    this.validateTruth(intent, truth);
    const exposureQuantity = Math.max(
      truth.order.executedQuantity,
      truth.fillsQuantity,
      truth.position?.quantity ?? 0,
    );
    if (exposureQuantity === 0) {
      if (truth.order.status === 'NEW') {
        return this.transition(record, {
          state: 'ORDER_SUBMITTED',
          entryStatus: 'NEW',
          exchangeOrderId: truth.order.exchangeOrderId,
          retryAuthorized: false,
          lastReason: 'ENTRY_OPEN_ON_EXCHANGE',
        });
      }
      if (truth.order.status === 'CANCELED' || truth.order.status === 'REJECTED') {
        return this.transition(record, {
          state: 'FAILED_CLOSED',
          entryStatus: truth.order.status,
          retryAuthorized: false,
          lastReason: 'ENTRY_TERMINAL_WITHOUT_EXPOSURE',
        });
      }
      if (record.state === 'EXIT_PENDING') {
        return this.transition(record, {
          state: 'CLOSED',
          entryStatus: truth.order.status,
          retryAuthorized: false,
          lastReason: 'FLAT_CONFIRMED_BY_EXCHANGE',
        });
      }
      return this.transition(record, {
        state: 'RECONCILIATION_REQUIRED',
        entryStatus: 'NOT_FOUND',
        retryAuthorized: true,
        lastReason: 'ENTRY_NOT_FOUND_RETRY_WITH_SAME_ID_ALLOWED',
      });
    }
    if (!truth.position) {
      return this.transition(record, {
        state: 'RECONCILIATION_REQUIRED',
        entryStatus: truth.order.status,
        filledQuantity: exposureQuantity,
        retryAuthorized: false,
        lastReason: 'FILLS_WITHOUT_POSITION_REQUIRES_RECONCILIATION',
      });
    }
    const plan = buildProtectionPlan(intent, truth.position);
    const entryStatus =
      exposureQuantity + Number.EPSILON < intent.quantity ? 'PARTIALLY_FILLED' : 'FILLED';
    record = this.transition(record, {
      state: entryStatus,
      entryStatus,
      exchangeOrderId: truth.order.exchangeOrderId,
      filledQuantity: exposureQuantity,
      averagePrice: truth.position.entryPrice || truth.order.averagePrice,
      retryAuthorized: false,
      lastReason: `${entryStatus}_CONFIRMED_BY_EXCHANGE`,
    });
    if (this.protectionMatches(truth.protection, truth.position, plan)) {
      return this.transition(record, {
        state: 'PROTECTED',
        protection: truth.protection,
        lastReason: 'PROTECTION_CONFIRMED_BY_EXCHANGE',
      });
    }
    record = this.transition(record, {
      state: 'PROTECTION_PENDING',
      protection: truth.protection,
      lastReason: 'PROTECTION_REQUIRED',
    });
    try {
      const protection = await this.exchange.ensureProtection(intent, truth.position, plan);
      if (!this.protectionMatches(protection, truth.position, plan)) {
        throw new DurableExecutionError('PROTECTION_VERIFICATION_FAILED');
      }
      return this.transition(record, {
        state: 'PROTECTED',
        protection,
        lastReason: 'PROTECTION_CREATED_AND_VERIFIED',
      });
    } catch {
      record = this.transition(record, {
        state: 'EXIT_PENDING',
        retryAuthorized: false,
        lastReason: 'PROTECTION_FAILED_EMERGENCY_EXIT_JOURNALED',
      });
      try {
        await this.exchange.submitReduceOnlyClose(intent, truth.position);
      } catch {
        return this.transition(record, {
          state: 'RECONCILIATION_REQUIRED',
          retryAuthorized: false,
          lastReason: 'PROTECTION_FAILED_EMERGENCY_EXIT_AMBIGUOUS',
        });
      }
      return this.reconcile(intent);
    }
  }

  async requestExit(intent: DurableEntryIntent): Promise<DurableExecutionRecord> {
    let record = await this.reconcile(intent);
    if (record.state === 'CLOSED' || record.state === 'FAILED_CLOSED') return record;
    const truth = await this.exchange.readTruth(intent);
    if (!truth.conclusive || !truth.position) return record;
    if (record.state !== 'EXIT_PENDING') {
      record = this.transition(record, {
        state: 'EXIT_PENDING',
        retryAuthorized: false,
        lastReason: 'EXIT_REQUEST_DURABLY_JOURNALED',
      });
      try {
        await this.exchange.submitReduceOnlyClose(intent, truth.position);
      } catch {
        return this.transition(record, {
          state: 'RECONCILIATION_REQUIRED',
          lastReason: 'EXIT_RESULT_AMBIGUOUS_READ_BEFORE_RETRY',
        });
      }
    }
    return this.reconcile(intent);
  }

  async recover(
    policyForUnmanagedPosition: (
      position: PositionTruth,
    ) => DurableProtectionPolicy | Promise<DurableProtectionPolicy>,
  ): Promise<DurableExecutionRecord[]> {
    const recovered: DurableExecutionRecord[] = [];
    for (const record of this.store.listNonTerminal()) {
      recovered.push(await this.reconcile(record.intent));
    }
    const known = new Set(
      recovered.map((record) => `${record.intent.symbol}:${record.intent.side}`),
    );
    for (const position of await this.exchange.discoverUnmanagedPositions()) {
      if (known.has(`${position.symbol}:${position.side}`)) continue;
      const createdAt = this.now();
      const intent = createDurableEntryIntent({
        signalId: `recovery:${position.symbol}:${position.side}:${position.entryPrice}`,
        symbol: position.symbol,
        side: position.side,
        quantity: position.quantity,
        expectedPrice: position.entryPrice,
        policyId: 'EXCHANGE_EXPOSURE_RECOVERY',
        featureHash: 'NOT_AVAILABLE_RECOVERED_FROM_EXCHANGE',
        createdAt,
        protectionPolicy: await policyForUnmanagedPosition(position),
      });
      let record = this.prepare(intent);
      record = this.transition(record, {
        state: 'RECONCILIATION_REQUIRED',
        filledQuantity: position.quantity,
        averagePrice: position.entryPrice,
        lastReason: 'LOCAL_STATE_LOST_EXCHANGE_POSITION_ADOPTED',
      });
      recovered.push(await this.reconcile(record.intent));
    }
    return recovered;
  }

  private transition(
    record: DurableExecutionRecord,
    patch: Partial<DurableExecutionRecord>,
  ): DurableExecutionRecord {
    const next: DurableExecutionRecord = {
      ...record,
      ...patch,
      revision: record.revision + 1,
      updatedAt: this.now(),
    };
    this.store.put(next, record.revision);
    return next;
  }

  private validateTruth(intent: DurableEntryIntent, truth: ExecutionTruth): void {
    if (truth.order.clientOrderId && truth.order.clientOrderId !== intent.clientOrderId) {
      throw new DurableExecutionError('EXCHANGE_ORDER_IDENTITY_CONFLICT');
    }
    for (const value of [
      truth.order.originalQuantity,
      truth.order.executedQuantity,
      truth.fillsQuantity,
      truth.position?.quantity ?? 0,
      truth.position?.entryPrice ?? 0,
    ]) {
      if (!Number.isFinite(value) || value < 0)
        throw new DurableExecutionError('EXCHANGE_TRUTH_INVALID');
    }
    if (
      truth.position &&
      (truth.position.symbol !== intent.symbol || truth.position.side !== intent.side)
    ) {
      throw new DurableExecutionError('EXCHANGE_POSITION_IDENTITY_CONFLICT');
    }
  }

  private protectionMatches(
    protection: ProtectionTruth,
    position: PositionTruth,
    plan: ProtectionPlan,
  ): boolean {
    return (
      protection.stopPresent &&
      protection.takeProfitPresent &&
      protection.protectedQuantity + Number.EPSILON >= position.quantity &&
      protection.stopPrice === plan.stopPrice &&
      protection.takeProfitPrice === plan.takeProfitPrice
    );
  }
}
