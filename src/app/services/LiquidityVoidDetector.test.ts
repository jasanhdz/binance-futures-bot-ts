import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../ports/Logger';
import { LiquidityVoidDetector } from './LiquidityVoidDetector';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('LiquidityVoidDetector', () => {
  it('accepts normalized bidDepth and askDepth levels', () => {
    const detector = new LiquidityVoidDetector(logger);

    detector.processDepthUpdate({
      bidDepth: [{ price: 99, qty: 1 }, { price: 98, qty: 9 }],
      askDepth: [{ price: 101, qty: 1 }, { price: 102, qty: 9 }],
    });

    expect(detector.getLiquidityStress()).toBe(0);
  });
});
