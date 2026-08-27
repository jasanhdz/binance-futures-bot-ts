import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AmbiguousExchangeResult,
  createDurableEntryIntent,
  DefinitiveExchangeRejection,
  DurableEntryIntent,
  DurableExecutionCoordinator,
  DurableExecutionExchange,
  ExecutionTruth,
  PositionTruth,
  ProtectionPlan,
  ProtectionTruth,
} from './DurableExecutionLifecycle';
import { FsDurableExecutionStore } from './FsDurableExecutionStore';

const POLICY = { stopRoe: -0.5, takeProfitRoe: 1, leverage: 10, pricePrecision: 2 };

function entry(signalId: string) {
  return createDurableEntryIntent({
    signalId,
    symbol: 'BTCUSDT',
    side: 'SHORT',
    quantity: 0.2,
    expectedPrice: 100,
    policyId: 'durable-acceptance-v1',
    featureHash: 'fixture-feature-hash',
    createdAt: '2026-08-12T00:00:00Z',
    protectionPolicy: POLICY,
  });
}

class StatefulFakeVenue implements DurableExecutionExchange {
  entryCalls: string[] = [];
  closeCalls: string[] = [];
  protectionCalls: Array<{ quantity: number; plan: ProtectionPlan }> = [];
  behavior: 'FILL' | 'PARTIAL' | 'REJECT' | 'TIMEOUT_ACCEPTED' | 'TIMEOUT_MISSING' = 'FILL';
  protectionBehavior: 'COMPLETE' | 'STOP_REJECTED' | 'TP_MISSING' = 'COMPLETE';
  truth: ExecutionTruth = this.flat('');

  async submitEntry(intent: DurableEntryIntent): Promise<void> {
    this.entryCalls.push(intent.clientOrderId);
    if (this.behavior === 'REJECT') throw new DefinitiveExchangeRejection('rejected');
    if (this.behavior === 'TIMEOUT_MISSING') {
      this.truth = this.flat(intent.clientOrderId);
      throw new AmbiguousExchangeResult('timeout before acceptance');
    }
    const quantity = this.behavior === 'PARTIAL' ? intent.quantity / 2 : intent.quantity;
    this.setPosition(intent, quantity);
    if (this.behavior === 'TIMEOUT_ACCEPTED') {
      throw new AmbiguousExchangeResult('timeout after acceptance');
    }
  }

  async readTruth(): Promise<ExecutionTruth> {
    return structuredClone(this.truth);
  }

  async ensureProtection(
    _intent: DurableEntryIntent,
    position: PositionTruth,
    plan: ProtectionPlan,
  ): Promise<ProtectionTruth> {
    this.protectionCalls.push({ quantity: position.quantity, plan });
    if (this.protectionBehavior === 'STOP_REJECTED') throw new Error('stop rejected');
    this.truth.protection = {
      stopPresent: true,
      takeProfitPresent: this.protectionBehavior !== 'TP_MISSING',
      protectedQuantity: position.quantity,
      stopPrice: plan.stopPrice,
      takeProfitPrice: plan.takeProfitPrice,
    };
    return structuredClone(this.truth.protection);
  }

  async submitReduceOnlyClose(intent: DurableEntryIntent): Promise<void> {
    this.closeCalls.push(intent.closeClientOrderId);
    this.truth = this.flat(intent.clientOrderId);
  }

  async discoverUnmanagedPositions(): Promise<PositionTruth[]> {
    return this.truth.position ? [structuredClone(this.truth.position)] : [];
  }

  setPosition(intent: DurableEntryIntent, quantity: number): void {
    this.truth = {
      order: {
        status: quantity < intent.quantity ? 'PARTIALLY_FILLED' : 'FILLED',
        clientOrderId: intent.clientOrderId,
        exchangeOrderId: 'fake-order-1',
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

  private flat(clientOrderId: string): ExecutionTruth {
    return {
      order: {
        status: 'NOT_FOUND',
        clientOrderId,
        originalQuantity: 0,
        executedQuantity: 0,
      },
      fillsQuantity: 0,
      position: null,
      protection: { stopPresent: false, takeProfitPresent: false, protectedQuantity: 0 },
      closeOrderFound: false,
      conclusive: true,
    };
  }
}

function journalRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-durable-acceptance-'));
}

describe('durable execution end-to-end acceptance', () => {
  it('runs intent through protected fill, restart, idempotent duplicate, exit, and accounting terminal', async () => {
    const venue = new StatefulFakeVenue();
    const root = journalRoot();
    const intended = entry('complete-lifecycle');
    const firstProcess = new DurableExecutionCoordinator(new FsDurableExecutionStore(root), venue);

    expect((await firstProcess.submit(intended)).state).toBe('PROTECTED');

    const restarted = new DurableExecutionCoordinator(new FsDurableExecutionStore(root), venue);
    expect((await restarted.submit(intended)).state).toBe('PROTECTED');
    expect(venue.entryCalls).toEqual([intended.clientOrderId]);

    const closed = await restarted.requestExit(intended);
    expect(closed.state).toBe('CLOSED');
    expect(venue.closeCalls).toEqual([intended.closeClientOrderId]);
    expect((await restarted.requestExit(intended)).state).toBe('CLOSED');
    expect(venue.closeCalls).toEqual([intended.closeClientOrderId]);
  });

  it('protects the exact partial fill and does not duplicate its entry', async () => {
    const venue = new StatefulFakeVenue();
    venue.behavior = 'PARTIAL';
    const intended = entry('partial-fill');
    const coordinator = new DurableExecutionCoordinator(
      new FsDurableExecutionStore(journalRoot()),
      venue,
    );

    const result = await coordinator.submit(intended);
    expect(result.state).toBe('PROTECTED');
    expect(result.entryStatus).toBe('PARTIALLY_FILLED');
    expect(venue.protectionCalls[0].quantity).toBe(intended.quantity / 2);
    expect((await coordinator.submit(intended)).state).toBe('PROTECTED');
    expect(venue.entryCalls).toHaveLength(1);
  });

  it('uses read-before-retry for both possible timeout outcomes', async () => {
    const acceptedVenue = new StatefulFakeVenue();
    acceptedVenue.behavior = 'TIMEOUT_ACCEPTED';
    const accepted = entry('accepted-timeout');
    const acceptedCoordinator = new DurableExecutionCoordinator(
      new FsDurableExecutionStore(journalRoot()),
      acceptedVenue,
    );
    expect((await acceptedCoordinator.submit(accepted)).state).toBe('PROTECTED');
    expect(acceptedVenue.entryCalls).toEqual([accepted.clientOrderId]);

    const missingVenue = new StatefulFakeVenue();
    missingVenue.behavior = 'TIMEOUT_MISSING';
    const missing = entry('missing-timeout');
    const missingCoordinator = new DurableExecutionCoordinator(
      new FsDurableExecutionStore(journalRoot()),
      missingVenue,
    );
    const uncertain = await missingCoordinator.submit(missing);
    expect(uncertain.state).toBe('MARKET_OPEN_AMBIGUOUS');
    expect(uncertain.retryAuthorized).toBe(false);
    missingVenue.behavior = 'FILL';
    const stillAmbiguous = await missingCoordinator.submit(missing);
    expect(stillAmbiguous.state).toBe('MARKET_OPEN_AMBIGUOUS');
    expect(stillAmbiguous.retryAuthorized).toBe(false);
    expect(missingVenue.entryCalls).toEqual([missing.clientOrderId]);
  });

  it('fails closed on a definitive entry rejection', async () => {
    const venue = new StatefulFakeVenue();
    venue.behavior = 'REJECT';
    const result = await new DurableExecutionCoordinator(
      new FsDurableExecutionStore(journalRoot()),
      venue,
    ).submit(entry('rejected-entry'));
    expect(result.state).toBe('FAILED_CLOSED');
    expect(result.entryStatus).toBe('REJECTED');
    expect(venue.closeCalls).toHaveLength(0);
  });

  it.each(['STOP_REJECTED', 'TP_MISSING'] as const)(
    'does not leave exposure unmanaged when protection result is %s',
    async (protectionBehavior) => {
      const venue = new StatefulFakeVenue();
      venue.protectionBehavior = protectionBehavior;
      const intended = entry(`protection-${protectionBehavior}`);
      const result = await new DurableExecutionCoordinator(
        new FsDurableExecutionStore(journalRoot()),
        venue,
      ).submit(intended);
      expect(result.state).toBe('CLOSED');
      expect(venue.closeCalls).toEqual([intended.closeClientOrderId]);
    },
  );

  it('recovers a fill before bracket and adopts exchange exposure after total local loss', async () => {
    const venue = new StatefulFakeVenue();
    const intended = entry('crash-before-bracket');
    venue.setPosition(intended, intended.quantity);

    const persistedRoot = journalRoot();
    new DurableExecutionCoordinator(new FsDurableExecutionStore(persistedRoot), venue).prepare(
      intended,
    );
    const restarted = new DurableExecutionCoordinator(
      new FsDurableExecutionStore(persistedRoot),
      venue,
    );
    expect((await restarted.recover(() => POLICY))[0].state).toBe('PROTECTED');

    venue.truth.protection = {
      stopPresent: false,
      takeProfitPresent: false,
      protectedQuantity: 0,
    };
    venue.truth.order = {
      status: 'NOT_FOUND',
      clientOrderId: '',
      originalQuantity: 0,
      executedQuantity: 0,
    };
    const emptyStoreRecovery = await new DurableExecutionCoordinator(
      new FsDurableExecutionStore(journalRoot()),
      venue,
    ).recover(() => POLICY);
    expect(emptyStoreRecovery).toHaveLength(1);
    expect(emptyStoreRecovery[0].state).toBe('PROTECTED');
    expect(emptyStoreRecovery[0].intent.policyId).toBe('EXCHANGE_EXPOSURE_RECOVERY');
  });
});
