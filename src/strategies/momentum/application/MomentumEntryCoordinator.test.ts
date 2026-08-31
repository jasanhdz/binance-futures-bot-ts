import { describe, expect, it, vi } from 'vitest';
import { MomentumEntryCoordinator } from './MomentumEntryCoordinator';

describe('MomentumEntryCoordinator', () => {
  it('delegates one symbol evaluation without owning execution', async () => {
    const evaluator = vi.fn().mockResolvedValue(true);
    const coordinator = new MomentumEntryCoordinator(evaluator);
    await expect(coordinator.evaluate('BTCUSDT')).resolves.toBe(true);
    expect(evaluator).toHaveBeenCalledWith('BTCUSDT');
  });
});
