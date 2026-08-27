import { describe, expect, it, vi } from 'vitest';

import { LiquidityVoidDetector, WsDepthUpdate } from './LiquidityVoidDetector';

describe('LiquidityVoidDetector', () => {
  it('computes bid and ask diagnostics from their respective sides', () => {
    const detector = new LiquidityVoidDetector({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const update: WsDepthUpdate = {
      bidDepth: [
        { price: 100, qty: 2 },
        { price: 99, qty: 3 },
      ],
      askDepth: [
        { price: 101, qty: 7 },
        { price: 102, qty: 11 },
      ],
    };

    detector.processDepthUpdate(update);

    expect((detector as any).calculateMetrics()).toEqual({
      bidTotalQty: 5,
      askTotalQty: 18,
      bidTopQty: 2,
      askTopQty: 7,
    });
    expect((detector as any).previousBidTotal).toBe(5);
    expect((detector as any).previousAskTotal).toBe(18);
  });

  it('reports receive age and stale status without changing stress', () => {
    const detector = new LiquidityVoidDetector({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    expect(detector.getLiquidityStressStatus(10_000)).toEqual({
      stress: 0,
      status: 'NO_DATA',
      inputVersion: 'DEPTH20_PARTIAL_V1',
    });
    detector.processDepthUpdate({
      bidDepth: [{ price: 100, qty: 1 }],
      askDepth: [{ price: 101, qty: 1 }],
      receivedAtMs: 9_500,
    });

    expect(detector.getLiquidityStressStatus(10_000)).toMatchObject({
      stress: 1,
      status: 'FRESH',
      inputVersion: 'DEPTH20_PARTIAL_V1',
      lastReceivedAtMs: 9_500,
      receiveAgeMs: 500,
    });
    expect(detector.getLiquidityStressStatus(10_501, 1_000).status).toBe('STALE');
  });

  it('detects sudden ask-side disappearance as well as bid-side disappearance', () => {
    const detector = new LiquidityVoidDetector({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const update = (qty: number) =>
      detector.processDepthUpdate({
        bidDepth: [{ price: 100, qty: 1 }],
        askDepth: [{ price: 101, qty }],
      });

    update(10);
    update(4);
    expect(detector.getLiquidityStress()).toBeGreaterThan(0);
  });
});
