import { describe, expect, it, vi } from 'vitest';
import { MicroBurstReferencePriceProvider } from './MicroBurstReferencePrice';

const NOW_MS = 1_700_000_000_000;

function createDeps(markPrice = 50000) {
  return {
    getMarkPrice: vi.fn().mockResolvedValue(markPrice),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

describe('MicroBurstReferencePriceProvider', () => {
  it('returns undefined before polling', () => {
    const deps = createDeps();
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new MicroBurstReferencePriceProvider(deps, clock);

    expect(provider.getReferencePrice('ETHUSDT')).toBeUndefined();
  });

  it('returns MARK_PRICE after polling', async () => {
    const deps = createDeps(50000);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new MicroBurstReferencePriceProvider(deps, clock);

    await provider.pollMarkPrice('ETHUSDT');

    const ref = provider.getReferencePrice('ETHUSDT');
    expect(ref).toBeDefined();
    expect(ref!.price).toBe(50000);
    expect(ref!.source).toBe('MARK_PRICE');
    expect(ref!.isLiveRuntime).toBe(true);
  });

  it('prefers MIDPOINT when book snapshot available', async () => {
    const deps = createDeps(50000);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new MicroBurstReferencePriceProvider(deps, clock);

    const ref = provider.getReferencePrice('ETHUSDT', {
      bidDepth: [{ price: 99.9 }],
      askDepth: [{ price: 100.1 }],
    });

    expect(ref).toBeDefined();
    expect(ref!.price).toBe(100);
    expect(ref!.source).toBe('MIDPOINT');
  });

  it('returns undefined when stale mark price', async () => {
    const deps = createDeps(50000);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new MicroBurstReferencePriceProvider(deps, clock, 5000);

    await provider.pollMarkPrice('ETHUSDT');
    clock.now.mockReturnValue(NOW_MS + 10_000);

    expect(provider.getReferencePrice('ETHUSDT')).toBeUndefined();
  });

  it('returns undefined when mark price is invalid', async () => {
    const deps = createDeps(NaN);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new MicroBurstReferencePriceProvider(deps, clock);

    await provider.pollMarkPrice('ETHUSDT');

    expect(provider.getReferencePrice('ETHUSDT')).toBeUndefined();
  });
});
