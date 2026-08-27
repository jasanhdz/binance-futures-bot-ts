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
});
