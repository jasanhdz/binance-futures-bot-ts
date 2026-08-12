import { describe, expect, it, vi } from 'vitest';
import { createDurableEntryIntent } from './DurableExecutionLifecycle';
import {
  DurableExecutionPorts,
  DurableExecutionTransport,
  DurableTransportProtection,
} from './DurableExecutionTransport';

function intent() {
  return createDurableEntryIntent({
    signalId: 'signal-1',
    symbol: 'ETHUSDT',
    side: 'LONG',
    quantity: 0.25,
    expectedPrice: 100,
    policyId: 'v18-test',
    featureHash: 'feature-hash',
    createdAt: '2026-08-12T00:00:00Z',
    protectionPolicy: {
      stopRoe: -0.5,
      takeProfitRoe: 1,
      leverage: 10,
      pricePrecision: 2,
    },
  });
}

function ports(): DurableExecutionPorts {
  return {
    submitEntry: vi.fn(),
    readEntry: vi.fn(async () => null),
    readFills: vi.fn(async () => 0),
    readPosition: vi.fn(async () => null),
    readProtection: vi.fn(async () => []),
    readClose: vi.fn(async () => false),
    placeStop: vi.fn(),
    placeTakeProfit: vi.fn(),
    submitReduceOnlyClose: vi.fn(),
    discoverPositions: vi.fn(async () => []),
  };
}

describe('DurableExecutionTransport', () => {
  it('returns conclusive exchange truth through explicit read-only ports', async () => {
    const bindings = ports();
    const entry = intent();
    bindings.readEntry = vi.fn(async () => ({
      status: 'PARTIALLY_FILLED',
      clientOrderId: entry.clientOrderId,
      orderId: '77',
      originalQuantity: 0.25,
      executedQuantity: 0.1,
      averagePrice: 101,
    }));
    bindings.readFills = vi.fn(async () => 0.1);
    bindings.readPosition = vi.fn(async () => ({
      symbol: 'ETHUSDT',
      side: 'LONG' as const,
      quantity: 0.1,
      entryPrice: 101,
    }));
    bindings.readProtection = vi.fn(
      async (): Promise<DurableTransportProtection[]> => [
        { kind: 'STOP', stopPrice: 95, quantity: 0.1, closePosition: false },
        { kind: 'TAKE_PROFIT', stopPrice: 110, quantity: 0.1, closePosition: false },
      ],
    );
    const truth = await new DurableExecutionTransport(bindings).readTruth(entry);
    expect(truth.conclusive).toBe(true);
    expect(truth.order.status).toBe('PARTIALLY_FILLED');
    expect(truth.protection.protectedQuantity).toBe(0.1);
  });

  it('fails reconciliation closed when any required read is ambiguous', async () => {
    const bindings = ports();
    bindings.readEntry = vi.fn(async () => {
      throw new Error('timeout');
    });
    const truth = await new DurableExecutionTransport(bindings).readTruth(intent());
    expect(truth.conclusive).toBe(false);
  });

  it('does not treat partially covered brackets as complete protection', async () => {
    const bindings = ports();
    bindings.readProtection = vi.fn(
      async (): Promise<DurableTransportProtection[]> => [
        { kind: 'STOP', stopPrice: 95, quantity: 0.25, closePosition: false },
        { kind: 'TAKE_PROFIT', stopPrice: 110, quantity: 0.1, closePosition: false },
      ],
    );
    const transport = new DurableExecutionTransport(bindings);
    const result = await transport.ensureProtection(
      intent(),
      { symbol: 'ETHUSDT', side: 'LONG', quantity: 0.25, entryPrice: 100 },
      { stopPrice: 95, takeProfitPrice: 110 },
    );
    expect(result.protectedQuantity).toBe(0.1);
    expect(bindings.placeStop).toHaveBeenCalledOnce();
    expect(bindings.placeTakeProfit).toHaveBeenCalledOnce();
  });
});
