import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GUARDIAN_CONFIG } from '../../domain/services/ProfitGuardian';
import { createUnfrozenStrategyIdentity } from '../../domain/strategy/StrategyIdentity';
import { strategyLifecyclePolicy } from '../../domain/strategy/StrategyLifecyclePolicy';
import { BotState } from '../../domain/types';
import { StrategyPositionLifecycleCore, StrategyPositionLifecyclePorts } from '../position/StrategyPositionLifecycleCore';
import { Exchange } from '../ports/Exchange';
import { StateStore } from '../ports/StateStore';
import { AegisPositionManager, MomentumRidePositionManager } from './OwnedPositionManagers';
import { PositionManagerRouter } from './PositionManagerRouter';

const aegisIdentity = createUnfrozenStrategyIdentity('AEGIS_TURBO', 'test', 'test-sha');
const momentumIdentity = createUnfrozenStrategyIdentity('MOMENTUM_RIDE', 'test', 'test-sha');

function stateStore(tradeId: string): StateStore {
  let state: BotState = {
    mode: 'LONG_RIDE',
    lastSide: 'LONG',
    lastEntryPrice: 100,
    lastEntryQty: 1,
    lastEntryAt: 1_000,
    lastTradeId: tradeId,
    positionOwner: 'BOT',
    tradeOrigin: 'BOT',
    ownershipStatus: 'VERIFIED',
    eligibleForBotMetrics: true,
  };
  return {
    get: () => state,
    set: patch => (state = { ...state, ...patch }),
    reset: () => undefined,
  };
}

function lifecycleCore(): StrategyPositionLifecycleCore {
  const exchange = {
    readActivePosition: vi.fn(async () => ({
      sideMode: 'BOTH' as const,
      qtyAbs: 1,
      entryPrice: 100,
      leverage: 2,
    })),
    getMarkPrice: vi.fn(async () => 100),
    getLastCandle: vi.fn(async () => null),
    getServerTime: vi.fn(async () => 2_000),
    getCandles: vi.fn(async () => []),
  } as unknown as Exchange;
  const ports: StrategyPositionLifecyclePorts = {
    exchange,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    notifier: { sendMessage: vi.fn(async () => undefined), sendAlert: vi.fn(async () => undefined) },
    defaultLeverage: () => 2,
    requireBrackets: () => false,
    getRegimeConfig: () => undefined,
    getGuardianConfig: () => DEFAULT_GUARDIAN_CONFIG,
    isVerifiedBotOwnedState: () => true,
    isLegacyBotOwnedState: () => false,
    consecutiveLosses: () => 0,
    calculateRoe: () => 0,
    entryMargin: () => 1,
    pnlFromRoe: () => 0,
    roundPrice: price => price,
    isBetterStop: () => false,
    formatRoe: value => String(value),
    notifyExit: vi.fn(async () => undefined),
    logTradeEvent: vi.fn(async () => undefined),
    safeMoveCloseStop: vi.fn(async input => ({ moved: false, reason: 'stop_not_improved', newStopPrice: input.newStopPrice })),
    ensureBrackets: vi.fn(async () => ({})),
    replaceBracketsForNewEntryPrice: vi.fn(async () => undefined),
    reconcilePositionSize: vi.fn(async () => ({ changed: false })),
  };
  return new StrategyPositionLifecycleCore(ports);
}

describe('owned position manager composition', () => {
  it('composes Aegis lifecycle with ExitEye', async () => {
    const core = lifecycleCore();
    const exitEye = vi.fn(async () => true);
    const manager = new AegisPositionManager(
      core.createAegisLifecycle(strategyLifecyclePolicy('AEGIS_TURBO'), exitEye),
    );
    const symbolState = stateStore('AEGIS-TURBO-test');

    await manager.manage(aegisIdentity, { symbol: 'BTCUSDT', botState: symbolState.get(), symbolState });

    expect(exitEye).toHaveBeenCalledOnce();
  });

  it('does not expose or invoke Aegis ExitEye through Momentum composition', async () => {
    const core = lifecycleCore();
    const exitEye = vi.fn(async () => false);
    core.createAegisLifecycle(strategyLifecyclePolicy('AEGIS_TURBO'), exitEye);
    const manager = new MomentumRidePositionManager(core);
    const symbolState = stateStore('MOMENTUM-RIDE-test');

    await manager.manage(momentumIdentity, { symbol: 'BTCUSDT', botState: symbolState.get(), symbolState });

    expect(exitEye).not.toHaveBeenCalled();
  });

  it('rejects an ownership mismatch before lifecycle execution', async () => {
    const core = lifecycleCore();
    const manager = new MomentumRidePositionManager(core);
    const symbolState = stateStore('AEGIS-TURBO-test');

    await expect(manager.manage(aegisIdentity, {
      symbol: 'BTCUSDT',
      botState: symbolState.get(),
      symbolState,
    })).rejects.toThrow('POSITION_MANAGER_OWNERSHIP_MISMATCH:MOMENTUM_RIDE:AEGIS_TURBO');
  });

  it('keeps router lifecycle execution manager-specific', async () => {
    const core = lifecycleCore();
    const exitEye = vi.fn(async () => true);
    const router = new PositionManagerRouter();
    router.register(new AegisPositionManager(
      core.createAegisLifecycle(strategyLifecyclePolicy('AEGIS_TURBO'), exitEye),
    ));
    router.register(new MomentumRidePositionManager(core));
    const momentumState = stateStore('MOMENTUM-RIDE-test');
    const aegisState = stateStore('AEGIS-TURBO-test');

    const momentum = await router.route(momentumIdentity, {
      symbol: 'BTCUSDT',
      botState: momentumState.get(),
      symbolState: momentumState,
    });
    const aegis = await router.route(aegisIdentity, {
      symbol: 'BTCUSDT',
      botState: aegisState.get(),
      symbolState: aegisState,
    });

    expect(momentum.status === 'ROUTED' && momentum.decision.reason).toBe('momentum_position_manager_completed');
    expect(aegis.status === 'ROUTED' && aegis.decision.reason).toBe('aegis_position_manager_completed');
    expect(exitEye).toHaveBeenCalledOnce();
  });
});
