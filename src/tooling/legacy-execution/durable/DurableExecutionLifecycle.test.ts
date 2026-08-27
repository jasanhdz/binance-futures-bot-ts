import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AmbiguousExchangeResult,
  createDurableEntryIntent,
  DurableEntryIntent,
  DurableExecutionCoordinator,
  DurableExecutionExchange,
  DurableExecutionRecord,
  DurableExecutionStore,
  EntryOrderTruth,
  ExecutionTruth,
  PositionTruth,
  ProtectionPlan,
  ProtectionTruth,
} from './DurableExecutionLifecycle';
import { FsDurableExecutionStore } from './FsDurableExecutionStore';
import { DurableAegisEntryExecutor } from './DurableAegisEntryExecutor';

const PLAN: ProtectionPlan = { stopPrice: 95, takeProfitPrice: 110 };
const POLICY = { stopRoe: -0.5, takeProfitRoe: 1, leverage: 10, pricePrecision: 2 };

class MemoryStore implements DurableExecutionStore {
  records = new Map<string, DurableExecutionRecord>();
  get(id: string) {
    return this.records.get(id) ?? null;
  }
  put(record: DurableExecutionRecord, expected: number | null) {
    const current = this.records.get(record.intent.intentId);
    expect(current?.revision ?? null).toBe(expected);
    this.records.set(record.intent.intentId, structuredClone(record));
  }
  listNonTerminal() {
    return [...this.records.values()].filter(
      (record) => !['CLOSED', 'FAILED_CLOSED'].includes(record.state),
    );
  }
}

class FakeExchange implements DurableExecutionExchange {
  submissions: string[] = [];
  closes: string[] = [];
  submitBehavior: 'ACK' | 'AMBIGUOUS_RECEIVED' | 'AMBIGUOUS_NOT_RECEIVED' = 'ACK';
  truth: ExecutionTruth;
  unmanaged: PositionTruth[] = [];
  protectionFails = false;

  constructor() {
    this.truth = this.flatTruth('');
  }

  async submitEntry(intent: DurableEntryIntent): Promise<void> {
    this.submissions.push(intent.clientOrderId);
    if (this.submitBehavior === 'AMBIGUOUS_RECEIVED') {
      this.fill(intent, intent.quantity);
      throw new AmbiguousExchangeResult('timeout after exchange accepted request');
    }
    if (this.submitBehavior === 'AMBIGUOUS_NOT_RECEIVED') {
      this.truth = this.flatTruth(intent.clientOrderId);
      throw new AmbiguousExchangeResult('timeout before exchange received request');
    }
    this.fill(intent, intent.quantity);
  }

  async readTruth(): Promise<ExecutionTruth> {
    return structuredClone(this.truth);
  }

  async ensureProtection(
    _intent: DurableEntryIntent,
    position: PositionTruth,
    plan: ProtectionPlan,
  ): Promise<ProtectionTruth> {
    if (this.protectionFails) throw new Error('protection rejected');
    this.truth.protection = {
      stopPresent: true,
      takeProfitPresent: true,
      protectedQuantity: position.quantity,
      stopPrice: plan.stopPrice,
      takeProfitPrice: plan.takeProfitPrice,
    };
    return structuredClone(this.truth.protection);
  }

  async submitReduceOnlyClose(intent: DurableEntryIntent): Promise<void> {
    this.closes.push(intent.closeClientOrderId);
    this.truth.position = null;
    this.truth.fillsQuantity = 0;
    this.truth.order.executedQuantity = 0;
    this.truth.protection = {
      stopPresent: false,
      takeProfitPresent: false,
      protectedQuantity: 0,
    };
  }

  async discoverUnmanagedPositions(): Promise<PositionTruth[]> {
    return structuredClone(this.unmanaged);
  }

  fill(intent: DurableEntryIntent, quantity: number): void {
    const status = quantity < intent.quantity ? 'PARTIALLY_FILLED' : 'FILLED';
    this.truth = {
      order: {
        status,
        clientOrderId: intent.clientOrderId,
        exchangeOrderId: 'exchange-1',
        originalQuantity: intent.quantity,
        executedQuantity: quantity,
        averagePrice: 100,
      },
      fillsQuantity: quantity,
      position: { symbol: intent.symbol, side: intent.side, quantity, entryPrice: 100 },
      protection: { stopPresent: false, takeProfitPresent: false, protectedQuantity: 0 },
      closeOrderFound: false,
      conclusive: true,
    };
  }

  flatTruth(clientOrderId: string): ExecutionTruth {
    const order: EntryOrderTruth = {
      status: 'NOT_FOUND',
      clientOrderId,
      originalQuantity: 0,
      executedQuantity: 0,
    };
    return {
      order,
      fillsQuantity: 0,
      position: null,
      protection: { stopPresent: false, takeProfitPresent: false, protectedQuantity: 0 },
      closeOrderFound: false,
      conclusive: true,
    };
  }
}

function intent(signalId = 'signal-1'): DurableEntryIntent {
  return createDurableEntryIntent({
    signalId,
    symbol: 'ETHUSDT',
    side: 'LONG',
    quantity: 2,
    expectedPrice: 100,
    policyId: 'v18-test',
    featureHash: 'feature-hash',
    createdAt: '2026-08-12T00:00:00Z',
    protectionPolicy: POLICY,
  });
}

describe('durable execution lifecycle', () => {
  it('returns a managed entry only after exact protection is confirmed', async () => {
    const exchange = new FakeExchange();
    const coordinator = new DurableExecutionCoordinator(new MemoryStore(), exchange);
    const executor = new DurableAegisEntryExecutor(coordinator);
    const entry = intent();
    const result = await executor.execute({
      signalId: entry.signalId,
      symbol: entry.symbol,
      side: entry.side,
      quantity: entry.quantity,
      expectedPrice: entry.expectedPrice,
      policyId: entry.policyId,
      featureHash: entry.featureHash,
      createdAt: entry.createdAt,
      protectionPolicy: entry.protectionPolicy,
    });
    expect(result.record.state).toBe('PROTECTED');
    expect(result.position.quantity).toBe(entry.quantity);
    expect(result.record.protection?.protectedQuantity).toBe(entry.quantity);
  });

  it('fails closed instead of returning an entry with partial bracket coverage', async () => {
    const exchange = new FakeExchange();
    exchange.ensureProtection = vi.fn(async (_intent, position, plan) => ({
      stopPresent: true,
      takeProfitPresent: true,
      protectedQuantity: position.quantity / 2,
      stopPrice: plan.stopPrice,
      takeProfitPrice: plan.takeProfitPrice,
    }));
    const executor = new DurableAegisEntryExecutor(
      new DurableExecutionCoordinator(new MemoryStore(), exchange),
    );
    const entry = intent('partial-protection');
    await expect(
      executor.execute({
        signalId: entry.signalId,
        symbol: entry.symbol,
        side: entry.side,
        quantity: entry.quantity,
        expectedPrice: entry.expectedPrice,
        policyId: entry.policyId,
        featureHash: entry.featureHash,
        createdAt: entry.createdAt,
        protectionPolicy: entry.protectionPolicy,
      }),
    ).rejects.toThrow('ENTRY_NOT_SAFELY_MANAGED:CLOSED');
    expect(exchange.closes).toEqual([entry.closeClientOrderId]);
  });

  it('creates deterministic Binance-safe identities and rejects identity conflicts', () => {
    const first = intent();
    const second = intent();
    expect(first).toEqual(second);
    expect(first.clientOrderId).toMatch(/^aegis-e-[a-f0-9]{24}$/);
    expect(first.clientOrderId.length).toBeLessThanOrEqual(36);
    const store = new MemoryStore();
    const coordinator = new DurableExecutionCoordinator(store, new FakeExchange());
    coordinator.prepare(first);
    expect(() => coordinator.prepare({ ...first, quantity: 3 })).toThrow(
      'INTENT_IDENTITY_CONFLICT',
    );
  });

  it('protects a partial fill for exactly the exchange position quantity', async () => {
    const exchange = new FakeExchange();
    const entry = intent();
    exchange.fill(entry, 0.75);
    const result = await new DurableExecutionCoordinator(new MemoryStore(), exchange).reconcile(
      entry,
    );
    expect(result.state).toBe('PROTECTED');
    expect(result.entryStatus).toBe('PARTIALLY_FILLED');
    expect(result.filledQuantity).toBe(0.75);
    expect(result.protection?.protectedQuantity).toBe(0.75);
  });

  it('reads exchange truth after an ambiguous timeout and never duplicates a received entry', async () => {
    const exchange = new FakeExchange();
    exchange.submitBehavior = 'AMBIGUOUS_RECEIVED';
    const entry = intent();
    const coordinator = new DurableExecutionCoordinator(new MemoryStore(), exchange);
    const result = await coordinator.submit(entry);
    expect(result.state).toBe('PROTECTED');
    expect(exchange.submissions).toEqual([entry.clientOrderId]);
    await coordinator.submit(entry);
    expect(exchange.submissions).toEqual([entry.clientOrderId]);
  });

  it('permits retry only after conclusive NOT_FOUND and reuses the same client order id', async () => {
    const exchange = new FakeExchange();
    exchange.submitBehavior = 'AMBIGUOUS_NOT_RECEIVED';
    const entry = intent();
    const coordinator = new DurableExecutionCoordinator(new MemoryStore(), exchange);
    const first = await coordinator.submit(entry);
    expect(first.state).toBe('RECONCILIATION_REQUIRED');
    expect(first.retryAuthorized).toBe(true);
    exchange.submitBehavior = 'ACK';
    const second = await coordinator.submit(entry);
    expect(second.state).toBe('PROTECTED');
    expect(exchange.submissions).toEqual([entry.clientOrderId, entry.clientOrderId]);
  });

  it('recovers after a crash between fill and bracket from an fsynced journal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-durable-'));
    const exchange = new FakeExchange();
    const entry = intent();
    const firstStore = new FsDurableExecutionStore(root);
    const first = new DurableExecutionCoordinator(firstStore, exchange);
    first.prepare(entry);
    exchange.fill(entry, entry.quantity);
    const reloaded = new FsDurableExecutionStore(root);
    const recovered = await new DurableExecutionCoordinator(reloaded, exchange).recover(
      () => POLICY,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0].state).toBe('PROTECTED');
    expect(reloaded.get(entry.intentId)?.protection?.stopPresent).toBe(true);
  });

  it('adopts and protects an exchange position after complete local state loss', async () => {
    const exchange = new FakeExchange();
    exchange.unmanaged = [{ symbol: 'ETHUSDT', side: 'LONG', quantity: 1, entryPrice: 100 }];
    exchange.truth = {
      ...exchange.flatTruth(''),
      position: exchange.unmanaged[0],
      fillsQuantity: 1,
    };
    const store = new MemoryStore();
    const recovered = await new DurableExecutionCoordinator(store, exchange).recover(() => POLICY);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].lastReason).toBe('PROTECTION_CREATED_AND_VERIFIED');
    expect(recovered[0].intent.policyId).toBe('EXCHANGE_EXPOSURE_RECOVERY');
  });

  it('journals emergency exit before closing when protection cannot be created', async () => {
    const exchange = new FakeExchange();
    exchange.protectionFails = true;
    const entry = intent();
    exchange.fill(entry, entry.quantity);
    const result = await new DurableExecutionCoordinator(new MemoryStore(), exchange).reconcile(
      entry,
    );
    expect(result.state).toBe('CLOSED');
    expect(exchange.closes).toEqual([entry.closeClientOrderId]);
  });

  it('does not submit a second close after exchange already reports flat', async () => {
    const exchange = new FakeExchange();
    const entry = intent();
    exchange.fill(entry, entry.quantity);
    const coordinator = new DurableExecutionCoordinator(new MemoryStore(), exchange);
    await coordinator.reconcile(entry);
    const closed = await coordinator.requestExit(entry);
    expect(closed.state).toBe('CLOSED');
    await coordinator.requestExit(entry);
    expect(exchange.closes).toEqual([entry.closeClientOrderId]);
  });

  it('fails closed on corrupt or revision-gapped durable journals', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-durable-corrupt-'));
    fs.writeFileSync(path.join(root, 'execution-lifecycle-v1.jsonl'), '{broken}\n');
    expect(() => new FsDurableExecutionStore(root)).toThrow('DURABLE_JOURNAL_CORRUPT');
  });
});
