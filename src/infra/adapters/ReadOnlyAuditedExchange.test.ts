import { describe, expect, it, vi } from 'vitest';
import { createReadOnlyAuditedExchange } from './ReadOnlyAuditedExchange';

describe('ReadOnlyAuditedExchange', () => {
  it('allows market reads and blocks every mutation without forwarding it', async () => {
    const marketOpen = vi.fn();
    const source = {
      getServerTime: vi.fn().mockResolvedValue(1),
      subscribeToAggTrades: vi.fn(),
      marketOpen,
      cancelOrderById: vi.fn(),
      setLeverage: vi.fn(),
      ensureMarginType: vi.fn(),
    } as any;
    const { exchange, audit } = createReadOnlyAuditedExchange(source, 'sha');

    await expect(exchange.getServerTime()).resolves.toBe(1);
    expect(() => (exchange as any).marketOpen('BTCUSDT', 'LONG', 1)).toThrow(
      'MUTATION_FORBIDDEN_IN_SHADOW_SOAK',
    );
    expect(() => (exchange as any).cancelOrderById('BTCUSDT', '1')).toThrow();
    expect(() => (exchange as any).setLeverage('BTCUSDT', 5)).toThrow();
    expect(() => (exchange as any).ensureMarginType('BTCUSDT', 'ISOLATED')).toThrow();
    expect(marketOpen).not.toHaveBeenCalled();
    expect(audit.readOnlyCalls.public).toBe(1);
    expect(audit.totalMutationAttempts).toBe(4);
    expect(audit.forwardedMutationCalls).toBe(0);
    expect(audit.blockedMutationAttempts).toMatchObject({
      marketOpen: 1,
      cancelOrderById: 1,
      setLeverage: 1,
      ensureMarginType: 1,
    });
  });
});
