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

  it('orchestrates protection, close, and notification effects without owning them', async () => {
    const service = new AegisExitManagementService(vi.fn());
    const context = {
      symbol: 'BTCUSDT',
      side: 'LONG',
      botState: {},
      symbolState: {},
      position: { qtyAbs: 1, sideMode: 'BOTH' },
      markPrice: 101,
      currentRoe: 0.1,
      peakRoe: 0.2,
      decision: {
        action: 'CLOSE_POSITION',
        shouldClose: true,
        shouldProtect: false,
        reason: 'neutral_momentum_decay_profit_exit',
        confidence: 'high',
        metadata: {
          symbol: 'BTCUSDT',
          positionSide: 'LONG',
          currentRoe: 0.1,
          peakRoe: 0.2,
          givebackRoe: 0.1,
        },
      },
    } as any;
    const effects = {
      protectProfit: vi.fn().mockResolvedValue(undefined),
      closePosition: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn().mockResolvedValue(undefined),
    };
    await expect(service.applyDecision(context, effects)).resolves.toBe('CLOSED');
    expect(effects.closePosition).toHaveBeenCalledWith(context, 'AEGIS_EXIT_EYE_NEUTRAL_DECAY');
    expect(effects.protectProfit).not.toHaveBeenCalled();
    expect(effects.notify).not.toHaveBeenCalled();
  });
});
