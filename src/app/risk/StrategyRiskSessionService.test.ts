import { describe, expect, it, vi } from 'vitest';
import { BotState } from '../../core/types';
import { StateStore } from '../ports/StateStore';
import { StrategyRiskSessionService } from './StrategyRiskSessionService';

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

function fixture(
  options: {
    now?: number;
    state?: StateStore;
    aegisOutcomes?: Array<{ tradeId: string; closedAt: string; pnlUsdt: number }>;
    strategyOutcomes?: Array<{ tradeId: string; closedAt: string; pnlUsdt: number }>;
  } = {},
) {
  let currentTime = options.now ?? Date.UTC(2026, 7, 31, 12);
  const state = options.state ?? store();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const lossStore = {
    strategyId: 'AEGIS_TURBO',
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
  };
  const service = new StrategyRiskSessionService({
    state,
    logger,
    getTradingMode: () => 'AEGIS_TURBO_MICRO_LIVE',
    readClosedOutcomes: vi.fn(async () => ({
      aegisOutcomes: options.aegisOutcomes ?? [],
      strategyOutcomes: options.strategyOutcomes ?? [],
    })),
    consecutiveLossStateStore: lossStore,
    now: () => currentTime,
  });
  return {
    service,
    state,
    logger,
    lossStore,
    setNow: (value: number) => {
      currentTime = value;
    },
  };
}

describe('StrategyRiskSessionService', () => {
  it('restores daily counters, strategy counters and the Aegis loss streak', async () => {
    const now = Date.UTC(2026, 7, 31, 12);
    const dayKey = Math.floor(now / 86_400_000);
    const state = store({
      dailyRisk: {
        dayKey,
        tradesToday: 3,
        strategyTradesToday: { AEGIS_TURBO: 2, MOMENTUM_RIDE: 1 },
        dailyStartBalance: 125,
      },
    });
    const outcomes = [
      { tradeId: 'AEGIS-TURBO-1', closedAt: '2026-08-31T08:00:00.000Z', pnlUsdt: -1 },
      { tradeId: 'AEGIS-TURBO-2', closedAt: '2026-08-31T09:00:00.000Z', pnlUsdt: -2 },
    ];
    const { service } = fixture({
      now,
      state,
      aegisOutcomes: outcomes,
      strategyOutcomes: outcomes,
    });

    await service.restore();

    expect(service.snapshot()).toMatchObject({
      tradesToday: 3,
      consecutiveLosses: 2,
      dailyStartBalance: 125,
      lastTradeDayReset: dayKey,
    });
    expect(service.strategySnapshot('AEGIS_TURBO', now).tradesToday).toBe(2);
    expect(service.strategySnapshot('MOMENTUM_RIDE', now).tradesToday).toBe(1);
  });

  it('records confirmed opens atomically in global and strategy daily state', async () => {
    const { service, state } = fixture();
    await service.restore();
    const openedAt = Date.UTC(2026, 7, 31, 12, 5);

    service.recordConfirmedOpen({
      strategyId: 'AEGIS_TURBO',
      openedAt,
      phaseOShortLive: true,
    });

    expect(service.snapshot()).toMatchObject({ tradesToday: 1, phaseOShortTradesToday: 1 });
    expect(service.strategySnapshot('AEGIS_TURBO', openedAt).tradesToday).toBe(1);
    expect(state.get().dailyRisk).toMatchObject({
      tradesToday: 1,
      strategyTradesToday: { AEGIS_TURBO: 1 },
    });
  });

  it('persists each distinct Aegis loss once while keeping the strategy ledger updated', async () => {
    const { service, lossStore } = fixture();
    await service.restore();
    const close = {
      strategyId: 'AEGIS_TURBO' as const,
      symbol: 'BTCUSDT',
      tradeId: 'AEGIS-TURBO-close-1',
      pnlUsdt: -1,
      closedAt: Date.UTC(2026, 7, 31, 12, 10),
      reason: 'STOP_LOSS',
    };

    service.recordStrategyClose(close);
    await service.recordAegisLossOutcome(close);
    service.recordStrategyClose(close);
    await service.recordAegisLossOutcome(close);

    expect(service.snapshot().consecutiveLosses).toBe(1);
    expect(service.strategySnapshot('AEGIS_TURBO', close.closedAt).consecutiveLosses).toBe(1);
    expect(lossStore.write).toHaveBeenCalledTimes(1);
    expect(lossStore.write).toHaveBeenCalledWith(
      expect.objectContaining({ consecutive_losses: 1, last_trade_id: close.tradeId }),
    );
  });

  it('resets all session counters and daily balance when the UTC day advances', async () => {
    const now = Date.UTC(2026, 7, 31, 23, 50);
    const { service, state, setNow } = fixture({ now });
    await service.restore();
    service.initializeDailyStartBalance(100, now);
    service.setDailyPnlPct(-0.02);
    service.recordConfirmedOpen({ strategyId: 'MOMENTUM_RIDE', openedAt: now });
    service.setPhaseOShortTradesToday(2);
    const nextDay = Date.UTC(2026, 8, 1, 0, 1);
    setNow(nextDay);

    service.checkDailyReset();

    expect(service.snapshot()).toEqual({
      tradesToday: 0,
      phaseOShortTradesToday: 0,
      consecutiveLosses: 0,
      dailyStartBalance: null,
      dailyPnlPct: undefined,
      lastTradeDayReset: Math.floor(nextDay / 86_400_000),
    });
    expect(state.get().dailyRisk).toMatchObject({
      tradesToday: 0,
      strategyTradesToday: { MOMENTUM_RIDE: 0 },
      dailyStartBalance: null,
    });
  });

  it('fails closed when durable risk recovery cannot be completed', async () => {
    const state = store();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new StrategyRiskSessionService({
      state,
      logger,
      getTradingMode: () => 'AEGIS_TURBO_MICRO_LIVE',
      readClosedOutcomes: async () => {
        throw new Error('history unavailable');
      },
    });

    await expect(service.restore()).rejects.toThrow('AEGIS_CONSECUTIVE_LOSS_RECOVERY_FAILED');
    expect(logger.error).toHaveBeenCalledWith(
      'aegis_consecutive_loss_streak_recovery_failed',
      expect.objectContaining({ error: expect.stringContaining('history unavailable') }),
    );
  });
});
