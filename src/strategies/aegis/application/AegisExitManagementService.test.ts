import { describe, expect, it, vi } from 'vitest';
import {
  AegisExitManagementService,
  type AegisExitManagementDeps,
} from './AegisExitManagementService';

function deps(overrides: Partial<AegisExitManagementDeps> = {}): AegisExitManagementDeps {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    notifier: { sendMessage: vi.fn(), sendAlert: vi.fn() },
    now: () => 1_000,
    getSignal: vi.fn().mockResolvedValue({ action: 'HOLD', reason: 'test' }),
    getExitEyeConfig: () =>
      ({
        enabled: false,
        mode: 'OFF',
        min_roe_to_protect: 0.1,
        min_peak_roe_to_protect: 0.2,
        min_giveback_from_peak_roe: 0.1,
        neutral_votes_to_protect: 2,
        opposite_votes_to_close: 2,
        min_roe_to_close_on_opposite: 0,
        min_peak_roe_to_close_on_opposite: 0,
        close_on_neutral_decay: false,
        neutral_close_votes: 3,
        min_roe_to_close_on_neutral: 0,
        min_peak_roe_to_close_on_neutral: 0,
        min_giveback_to_close_on_neutral: 0,
        require_consecutive_neutral_close: 1,
        require_consecutive_neutral: 1,
        require_consecutive_opposite: 1,
        min_minutes_in_trade: 0,
      }) as any,
    getEntryThreshold: () => 0.5,
    logTradeEvent: vi.fn().mockResolvedValue(undefined),
    protectProfit: vi.fn().mockResolvedValue(undefined),
    executePositionClose: vi.fn().mockResolvedValue(undefined),
    notifyExit: vi.fn().mockResolvedValue(undefined),
    formatRoe: (value) => `${value}`,
    ...overrides,
  };
}

describe('AegisExitManagementService', () => {
  it('owns a complete disabled evaluation and records V2 shadow evidence', async () => {
    const input = {
      symbol: 'BTCUSDT',
      side: 'SHORT',
      markPrice: 100,
      currentRoe: 0.1,
      peakRoe: 0.2,
      lowestRoe: 0,
      tradeDurationMs: 1000,
      botState: {},
      symbolState: { get: () => ({ mode: 'IDLE' }), set: vi.fn(), reset: vi.fn() },
      position: { qtyAbs: 1, entryPrice: 100, leverage: 10, sideMode: 'BOTH' },
    } as any;
    const serviceDeps = deps();
    const service = new AegisExitManagementService(serviceDeps);

    await expect(service.evaluate(input)).resolves.toBe(false);
    expect(serviceDeps.getSignal).toHaveBeenCalledWith('BTCUSDT');
    expect(serviceDeps.logTradeEvent).toHaveBeenCalledWith(
      'BTCUSDT',
      'EXIT_EYE_V2_SHADOW_OBSERVATION',
      expect.any(Object),
    );
  });

  it('delegates position closure through the abstract execution port', async () => {
    const executePositionClose = vi.fn().mockResolvedValue(undefined);
    const service = new AegisExitManagementService(deps({ executePositionClose }));
    const input = {
      symbol: 'BTCUSDT',
      side: 'LONG' as const,
      qtyAbs: 1.25,
      sideMode: 'BOTH' as const,
      reason: 'AEGIS_EXIT_EYE_OPPOSITE_SIGNAL',
    };

    await service.closePosition(input);
    expect(executePositionClose).toHaveBeenCalledWith(input);
  });

  it('orchestrates close effects from the canonical decision classifier', async () => {
    const service = new AegisExitManagementService(deps());
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
