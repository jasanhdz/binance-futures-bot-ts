import { describe, expect, it, vi } from 'vitest';
import {
  AegisProfitProtectionService,
  type AegisProfitProtectionDeps,
} from './AegisProfitProtectionService';

function deps(overrides: Partial<AegisProfitProtectionDeps> = {}): AegisProfitProtectionDeps {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    notifier: { sendMessage: vi.fn(), sendAlert: vi.fn() },
    now: () => 1_000,
    getConfig: () => ({
      enabled: true,
      protect_profit_enabled: true,
      min_peak_roe_to_protect: 0.1,
      protect_giveback_roe: 0.05,
      min_locked_roe: 0.02,
      be_offset_pct: 0,
      immediate_trigger_buffer_pct: 0.001,
    }),
    getFallbackLeverage: () => 10,
    getSymbolFilters: vi.fn().mockResolvedValue({
      tickSize: 0.01,
      stepSize: 0.001,
      pricePrecision: 2,
      qtyPrecision: 3,
      minNotional: 5,
    }),
    roundPrice: (price) => Number(price.toFixed(2)),
    useClosePosition: () => false,
    moveCloseStop: vi.fn().mockResolvedValue({ moved: true, newStopPrice: 100.5 }),
    logTradeEvent: vi.fn().mockResolvedValue(undefined),
    formatRoe: (value) => `${value}`,
    ...overrides,
  };
}

const input = {
  symbol: 'BTCUSDT',
  side: 'LONG' as const,
  botState: { mode: 'LONG_RIDE' as const, lastEntryPrice: 100, lastLeverage: 10 },
  symbolState: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
  position: { qtyAbs: 1, entryPrice: 100, leverage: 10, sideMode: 'BOTH' as const },
  markPrice: 102,
  currentRoe: 0.2,
  peakRoe: 0.25,
  decision: { action: 'PROTECT_PROFIT', reason: 'test', metadata: {} } as any,
};

describe('AegisProfitProtectionService', () => {
  it('moves the stop through the abstract protection port and updates state', async () => {
    const serviceDeps = deps();
    const service = new AegisProfitProtectionService(serviceDeps);

    await expect(service.execute(input)).resolves.toMatchObject({ moved: true });
    expect(serviceDeps.moveCloseStop).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT', reason: 'PROTECT_PROFIT' }),
    );
    expect(input.symbolState.set).toHaveBeenCalledWith(
      expect.objectContaining({ lastStopPrice: 100.5 }),
    );
  });

  it('does not request execution when protection is disabled', async () => {
    const moveCloseStop = vi.fn();
    const service = new AegisProfitProtectionService(
      deps({
        moveCloseStop,
        getConfig: () => ({
          enabled: false,
          protect_profit_enabled: false,
          min_peak_roe_to_protect: 1,
          protect_giveback_roe: 0.05,
          min_locked_roe: 0.02,
          be_offset_pct: 0,
          immediate_trigger_buffer_pct: 0.001,
        }),
      }),
    );

    await expect(service.execute(input)).resolves.toMatchObject({ moved: false });
    expect(moveCloseStop).not.toHaveBeenCalled();
  });
});
