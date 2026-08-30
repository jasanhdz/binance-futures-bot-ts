import { describe, expect, it, vi } from 'vitest';
import type { BotState } from '../../core/types';
import type { StateStore } from '../ports/StateStore';
import { PositionRecoveryService } from './PositionRecoveryService';

function store(initial: Partial<BotState> = {}): StateStore {
  let state = { mode: 'IDLE', ...initial } as BotState;
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      return state;
    },
    reset: () => {
      state = { mode: 'IDLE' } as BotState;
    },
  };
}

function basePorts(overrides: Record<string, unknown> = {}) {
  const symbolState = store();
  const globalState = store();
  globalState.forSymbol = () => symbolState;
  return {
    symbolState,
    globalState,
    ports: {
      exchange: {
        hasOpenPosition: vi.fn().mockResolvedValue(false),
        readActivePosition: vi.fn().mockResolvedValue(null),
      } as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      notifier: { sendAlert: vi.fn().mockResolvedValue(undefined) } as any,
      globalState,
      configSymbols: ['BTCUSDT'],
      getLiveSymbols: () => ['BTCUSDT'],
      stateForSymbol: () => symbolState,
      isVerifiedBotOwnedState: (state: BotState) => state.ownershipStatus === 'VERIFIED',
      isLegacyBotOwnedState: (state: BotState) =>
        typeof state.lastTradeId === 'string' && state.lastTradeId.startsWith('AEGIS-TURBO-'),
      requireBrackets: () => true,
      ensureBrackets: vi.fn().mockResolvedValue({ stopPrice: 95, takeProfitPrice: 110 }),
      ...overrides,
    } as any,
  };
}

describe('PositionRecoveryService', () => {
  it('adopts a manual exchange position as EXTERNAL without strategy authority', async () => {
    const fixture = basePorts();
    fixture.ports.exchange.hasOpenPosition.mockResolvedValue(true);
    fixture.ports.exchange.readActivePosition.mockImplementation(
      async (_symbol: string, side: string) =>
        side === 'LONG'
          ? {
              qtyAbs: 1,
              entryPrice: 100,
              leverage: 5,
              isolatedMargin: 20,
              sideMode: 'ONE_WAY',
            }
          : null,
    );
    const recovery = new PositionRecoveryService(fixture.ports);

    expect(await recovery.tryAdoptManualPositionRuntime('BTCUSDT')).toBe(true);
    expect(fixture.symbolState.get()).toMatchObject({
      mode: 'LONG_RIDE',
      lastSide: 'LONG',
      positionOwner: 'EXTERNAL',
      tradeOrigin: 'MANUAL_EXTERNAL',
      eligibleForBotMetrics: false,
      metricsExclusionReason: 'MANUAL_POSITION',
      lastStopPrice: 95,
    });
    expect(fixture.ports.ensureBrackets).toHaveBeenCalledTimes(1);
  });

  it('moves legacy global state into the first live symbol without changing its payload', async () => {
    const fixture = basePorts();
    fixture.globalState.set({
      mode: 'SHORT_RIDE',
      lastSide: 'SHORT',
      lastTradeId: 'AEGIS-TURBO-BTCUSDT-legacy',
      lastEntryPrice: 101,
    });
    const recovery = new PositionRecoveryService(fixture.ports);

    await recovery.migrateLegacyGlobalStateToFirstLiveSymbol();

    expect(fixture.symbolState.get()).toMatchObject({
      mode: 'SHORT_RIDE',
      lastSide: 'SHORT',
      lastTradeId: 'AEGIS-TURBO-BTCUSDT-legacy',
      lastEntryPrice: 101,
    });
    expect(fixture.globalState.get()).toMatchObject({
      mode: 'IDLE',
      lastExitReason: 'MIGRATED_TO_SYMBOL_STATE',
    });
  });
});
