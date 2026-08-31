import { describe, expect, it, vi } from 'vitest';
import {
  AegisEntryWorkflow,
  type AegisEntryWorkflowDeps,
} from './AegisEntryWorkflow';

describe('AegisEntryWorkflow', () => {
  it('owns the first LIVE gate and exits before exchange ownership reads', async () => {
    const hasOpenPosition = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const workflow = new AegisEntryWorkflow({
      exchange: { hasOpenPosition },
      logger,
      notifier: {},
      configManager: {},
      stateForSymbol: () => ({ get: () => ({ mode: 'IDLE' }) }),
      getAegisTurboYamlConfig: () => ({ enabled: true, live_enabled: true }),
      canExecuteLive: () => false,
      getSymbolMode: () => 'SHADOW',
      getTradingMode: () => 'AEGIS_TURBO_MICRO_LIVE',
    } as unknown as AegisEntryWorkflowDeps);

    await workflow.execute(
      'BTCUSDT',
      { action: 'LONG', reason: 'test' } as any,
      { allowed: true, side: 'LONG' } as any,
      'trade-1',
    );

    expect(hasOpenPosition).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'aegis_live_execution_blocked_by_symbol_mode',
      expect.objectContaining({ symbol: 'BTCUSDT', symbolMode: 'SHADOW' }),
    );
  });
});
