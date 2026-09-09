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
      isEntryRecoveryPending: () => false,
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
  it.each(['in-flight', 'ambiguous', 'accounting'])(
    'does not adopt or place manual brackets while %s evidence is pending',
    async (pending) => {
      const fixture = basePorts({ isEntryRecoveryPending: () => pending === 'in-flight' });
      fixture.symbolState.set({
        marketOpenAmbiguous: pending === 'ambiguous',
        microBurstPnlUnverified: pending === 'accounting',
      });
      const before = fixture.symbolState.get();
      fixture.ports.exchange.hasOpenPosition.mockResolvedValue(true);
      fixture.ports.exchange.readActivePosition.mockResolvedValue({ qtyAbs: 3295 });

      expect(
        await new PositionRecoveryService(fixture.ports).tryAdoptManualPositionRuntime('ADAUSDT'),
      ).toBe(false);
      expect(fixture.symbolState.get()).toEqual(before);
      expect(fixture.ports.exchange.hasOpenPosition).not.toHaveBeenCalled();
      expect(fixture.ports.ensureBrackets).not.toHaveBeenCalled();
    },
  );

  it.each(['hasOpenPosition', 'readActivePosition'])(
    'rechecks entry reservations after awaiting %s',
    async (read) => {
      let pending = false;
      const fixture = basePorts({ isEntryRecoveryPending: () => pending });
      fixture.ports.exchange.hasOpenPosition.mockResolvedValue(true);
      fixture.ports.exchange.readActivePosition.mockResolvedValue({ qtyAbs: 3295 });
      fixture.ports.exchange[read].mockImplementation(async () => {
        pending = true;
        return read === 'hasOpenPosition' ? true : { qtyAbs: 3295 };
      });
      const before = fixture.symbolState.get();

      expect(
        await new PositionRecoveryService(fixture.ports).tryAdoptManualPositionRuntime('ADAUSDT'),
      ).toBe(false);
      expect(fixture.symbolState.get()).toEqual(before);
      expect(fixture.ports.ensureBrackets).not.toHaveBeenCalled();
    },
  );

  it.each(['MICRO_BURST', 'MOMENTUM_RIDE'] as const)(
    'does not overwrite a %s ownership handoff completed during an exchange read',
    async (strategy) => {
      const fixture = basePorts();
      fixture.ports.exchange.hasOpenPosition.mockResolvedValue(true);
      fixture.ports.exchange.readActivePosition.mockImplementation(async () => {
        fixture.symbolState.set({
          mode: 'SHORT_RIDE',
          lastStrategy: strategy,
          lastTradeId: 'micro-trade',
          positionOwner: 'BOT',
        });
        return { qtyAbs: 3295, entryPrice: 0.2189, leverage: 20, sideMode: 'BOTH' };
      });

      expect(
        await new PositionRecoveryService(fixture.ports).tryAdoptManualPositionRuntime('ADAUSDT'),
      ).toBe(false);
      expect(fixture.symbolState.get()).toMatchObject({
        lastTradeId: 'micro-trade',
        positionOwner: 'BOT',
      });
      expect(fixture.ports.ensureBrackets).not.toHaveBeenCalled();
    },
  );

  it.each(['in-flight', 'ambiguous', 'accounting'])(
    'leaves startup positions to recovery while %s evidence is pending',
    async (pending) => {
      const fixture = basePorts({ isEntryRecoveryPending: () => pending === 'in-flight' });
      fixture.symbolState.set({
        marketOpenAmbiguous: pending === 'ambiguous',
        microBurstPnlUnverified: pending === 'accounting',
      });
      fixture.ports.exchange.readActivePosition.mockResolvedValue({ qtyAbs: 3295 });
      await new PositionRecoveryService(fixture.ports).attachOpenExchangePositionsToSymbolState();
      expect(fixture.symbolState.get().mode).toBe('IDLE');
      expect(fixture.ports.exchange.readActivePosition).not.toHaveBeenCalled();
      expect(fixture.ports.ensureBrackets).not.toHaveBeenCalled();
    },
  );

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
    expect(fixture.ports.ensureBrackets.mock.calls[0][6]).toEqual({
      stopRoe: -0.4,
      takeProfitRoe: 1.0,
    });
  });

  it.each(['MICRO_BURST', 'MOMENTUM_RIDE'] as const)(
    'does not convert incomplete %s startup ownership into manual protection',
    async (strategy) => {
      const fixture = basePorts();
      fixture.symbolState.set({
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastEntryPrice: 100,
        lastStrategy: strategy,
        lastTradeId: 'incomplete-bot-trade',
        positionOwner: 'BOT',
        tradeOrigin: 'BOT',
        ownershipStatus: 'VERIFIED',
      });
      fixture.ports.exchange.readActivePosition.mockResolvedValue({
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 5,
        sideMode: 'BOTH',
      });
      await new PositionRecoveryService(fixture.ports).attachOpenExchangePositionsToSymbolState();
      expect(fixture.symbolState.get()).toMatchObject({
        positionOwner: 'UNKNOWN',
        tradeOrigin: 'UNKNOWN',
        lastStrategy: strategy,
        lastTradeId: 'incomplete-bot-trade',
        metricsExclusionReason: 'ENTRY_ORDER_ID_MISSING_AFTER_RESTART',
      });
      expect(fixture.ports.ensureBrackets).not.toHaveBeenCalled();
    },
  );

  it.each(['blank', 'external', 'unknown'])(
    'handles %s startup state without confusing external and unresolved ownership',
    async (kind) => {
      const fixture = basePorts();
      if (kind !== 'blank')
        fixture.symbolState.set({
          mode: 'LONG_RIDE',
          lastSide: 'LONG',
          lastEntryPrice: 100,
          positionOwner: kind === 'external' ? 'EXTERNAL' : 'UNKNOWN',
          tradeOrigin: kind === 'external' ? 'MANUAL_EXTERNAL' : 'UNKNOWN',
          ownershipStatus: 'UNKNOWN',
        });
      fixture.ports.exchange.readActivePosition.mockResolvedValue({
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 5,
        sideMode: 'BOTH',
      });
      await new PositionRecoveryService(fixture.ports).attachOpenExchangePositionsToSymbolState();
      if (kind === 'unknown') {
        expect(fixture.symbolState.get().positionOwner).toBe('UNKNOWN');
        expect(fixture.ports.ensureBrackets).not.toHaveBeenCalled();
      } else {
        expect(fixture.symbolState.get().positionOwner).toBe('EXTERNAL');
        expect(fixture.symbolState.get().lastStopPrice).toBe(95);
        expect(fixture.ports.ensureBrackets).toHaveBeenCalledTimes(1);
        expect(fixture.ports.ensureBrackets.mock.calls[0][6]).toEqual({
          stopRoe: -0.4,
          takeProfitRoe: 1.0,
        });
      }
    },
  );

  it.each(['MICRO_BURST', 'MOMENTUM_RIDE'] as const)(
    'preserves verified %s startup identity without manual brackets',
    async (strategy) => {
      const fixture = basePorts();
      fixture.symbolState.set({
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastStrategy: strategy,
        lastTradeId: 'bot-trade',
        lastOrderId: 'order-1',
        positionOwner: 'BOT',
        tradeOrigin: 'BOT',
        ownershipStatus: 'VERIFIED',
      });
      const before = fixture.symbolState.get();
      fixture.ports.exchange.readActivePosition.mockResolvedValue({
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 5,
        sideMode: 'BOTH',
      });
      await new PositionRecoveryService(fixture.ports).attachOpenExchangePositionsToSymbolState();
      expect(fixture.symbolState.get()).toEqual(before);
      expect(fixture.ports.ensureBrackets).not.toHaveBeenCalled();
    },
  );

  it('rechecks durable pending evidence after a startup exchange read', async () => {
    let pending = false;
    const fixture = basePorts({ isEntryRecoveryPending: () => pending });
    fixture.ports.exchange.readActivePosition.mockImplementation(async () => {
      pending = true;
      return { qtyAbs: 1, entryPrice: 100, leverage: 5, sideMode: 'BOTH' };
    });
    await new PositionRecoveryService(fixture.ports).attachOpenExchangePositionsToSymbolState();
    expect(fixture.symbolState.get().mode).toBe('IDLE');
    expect(fixture.ports.ensureBrackets).not.toHaveBeenCalled();
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
