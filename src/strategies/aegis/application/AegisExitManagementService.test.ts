import { describe, expect, it, vi } from 'vitest';
import { AegisExitManagementService } from './AegisExitManagementService';

describe('AegisExitManagementService', () => {
  it('delegates one complete position evaluation without owning exchange execution', async () => {
    const evaluate = vi.fn().mockResolvedValue(true);
    const service = new AegisExitManagementService(evaluate);
    const input = { symbol: 'BTCUSDT', side: 'SHORT', markPrice: 100, currentRoe: 0.1, peakRoe: 0.2, lowestRoe: 0, tradeDurationMs: 1000, botState: {}, symbolState: {}, position: {} } as any;
    await expect(service.evaluate(input)).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledWith(input);
  });

  it('delegates profitable position closure through the execution port', async () => {
    const closeSideMarketSafe = vi.fn().mockResolvedValue(undefined);
    const service = new AegisExitManagementService(vi.fn(), {
      execution: {
        readActivePosition: vi.fn(),
        listCloseOrdersForSide: vi.fn(),
        closeSideMarketSafe,
      },
    });
    await service.closePosition({
      symbol: 'BTCUSDT',
      side: 'LONG',
      qtyAbs: 1.25,
      sideMode: 'BOTH',
      reason: 'AEGIS_EXIT_EYE_OPPOSITE_SIGNAL',
    });
    expect(closeSideMarketSafe).toHaveBeenCalledWith(
      'BTCUSDT',
      'LONG',
      1.25,
      'BOTH',
      'AEGIS_EXIT_EYE_OPPOSITE_SIGNAL',
    );
  });
});
