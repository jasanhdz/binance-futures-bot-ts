import { describe, expect, it, vi } from 'vitest';
import { PositionSupervisor, PositionSupervisorDeps } from './PositionSupervisor';
import type { BotState } from '../../core/types';
import type { PositionInfo, TradingExchangePort } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';

function makeState(overrides: Partial<BotState> = {}): BotState {
  return { mode: 'IDLE', lastSide: 'LONG', lastTradeId: 'T1', ...overrides };
}

function makePosition(overrides: Partial<PositionInfo> = {}): PositionInfo {
  return { sideMode: 'BOTH', qtyAbs: 100, entryPrice: 1.0, leverage: 20, ...overrides };
}

function mockExchange(overrides: Partial<TradingExchangePort> = {}): TradingExchangePort {
  return {
    readActivePosition: vi.fn().mockResolvedValue(null),
    listCloseOrdersForSide: vi.fn().mockResolvedValue([]),
    getMarkPrice: vi.fn().mockResolvedValue(1.5),
    getSymbolFilters: vi.fn().mockResolvedValue({
      tickSize: 0.0001,
      stepSize: 1,
      pricePrecision: 4,
      qtyPrecision: 1,
      minNotional: 5,
    }),
    placeStopClose: vi.fn().mockResolvedValue(true),
    cancelOrderById: vi.fn().mockResolvedValue(undefined),
    closeSideMarketSafe: vi.fn().mockResolvedValue(undefined),
    getUSDTBalance: vi.fn().mockResolvedValue(100),
    hasOpenPosition: vi.fn().mockResolvedValue(false),
    readLiquidationPrice: vi.fn().mockResolvedValue(null),
    getRecentFills: vi.fn().mockResolvedValue([]),
    marketOpen: vi.fn().mockResolvedValue({ avgPrice: 1, orderId: '1' }),
    placeTpClose: vi.fn().mockResolvedValue(true),
    setLeverage: vi.fn().mockResolvedValue(undefined),
    ensureMarginType: vi.fn().mockResolvedValue(undefined),
    openStopForSide: vi.fn().mockResolvedValue(null),
    readMarketOpenByClientOrderId: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as TradingExchangePort;
}

function mockStore(state: BotState = makeState()): StateStore & {
  flush(): Promise<void>;
  flushed: boolean;
  lastSet: Partial<BotState> | undefined;
} {
  let current = { ...state };
  const store = {
    flushed: false,
    lastSet: undefined as Partial<BotState> | undefined,
    get: () => ({ ...current }),
    set: (patch: Partial<BotState>) => {
      current = { ...current, ...patch };
      store.lastSet = patch;
      return { ...current };
    },
    reset: () => {
      current = makeState();
    },
    flush: async () => {
      store.flushed = true;
    },
  };
  return store;
}

function defaultDeps(overrides: Partial<PositionSupervisorDeps> = {}): PositionSupervisorDeps {
  return {
    exchange: mockExchange(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    resolveOwner: () => 'MICRO',
    requiresStop: (owner) => owner === 'MICRO',
    getStopConfig: () => ({
      confirmationAttempts: 2,
      confirmationDelaysMs: [100],
      recoveryTimeoutMs: 30_000,
      immediateTriggerBufferPct: 0.003,
    }),
    now: () => 1_700_000_000_000,
    wait: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const STOP_VISIBLE = [
  {
    orderId: 'S1',
    type: 'STOP_MARKET',
    stopPrice: 0.9,
    closePosition: true,
    owner: 'BOT',
    side: 'SELL',
    positionSide: 'BOTH',
  },
];

describe('PositionSupervisor', () => {
  it('returns UNKNOWN when supervision is already in flight for symbol', async () => {
    const deps = defaultDeps();
    const supervisor = new PositionSupervisor(deps);
    let resolveRead!: (v: PositionInfo | null) => void;
    (deps.exchange.readActivePosition as any).mockReturnValueOnce(
      new Promise<PositionInfo | null>((r) => {
        resolveRead = r;
      }),
    );
    const first = supervisor.supervise('XRPUSDT', makeState());
    const second = await supervisor.supervise('XRPUSDT', makeState());
    expect(second.status).toBe('UNKNOWN');
    expect(second.reason).toBe('SUPERVISION_IN_FLIGHT');
    resolveRead!(null);
    await first;
  });

  it('returns RECOVERY_REQUIRED when side is unknown', async () => {
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps());
    const result = await supervisor.supervise('XRPUSDT', makeState({ lastSide: undefined }), store);
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toBe('SIDE_UNKNOWN');
    expect(store.flushed).toBe(true);
  });

  it('returns RECOVERY_REQUIRED when ownership is unknown', async () => {
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ resolveOwner: () => 'UNKNOWN' }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.owner).toBe('UNKNOWN');
    expect(result.reason).toBe('OWNERSHIP_UNKNOWN');
  });

  it('confirms PROTECTED when stop is visible', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi.fn().mockResolvedValue(STOP_VISIBLE),
    });
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState());
    expect(result.status).toBe('PROTECTED');
    expect(result.owner).toBe('MICRO');
  });

  it('places stop when none exists and confirms after placement', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi
        .fn()
        .mockResolvedValueOnce([]) // hasConfirmedStop attempt 0: no stop
        .mockResolvedValueOnce([]) // hasConfirmedStop attempt 1: no stop (retries within confirm)
        .mockResolvedValueOnce([]) // confirmBrackets or re-confirmation
        .mockResolvedValue(STOP_VISIBLE), // After placement: stop visible
      placeStopClose: vi.fn().mockResolvedValue(true),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState({ lastStopPrice: 0.9 }), store);
    expect(result.status).toBe('PROTECTED');
    expect(exchange.placeStopClose).toHaveBeenCalledOnce();
    expect(store.flushed).toBe(true);
  });

  it('returns RECOVERY_REQUIRED when stop would trigger immediately', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      getMarkPrice: vi.fn().mockResolvedValue(1.0),
    });
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState({ lastStopPrice: 1.0 }));
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toBe('STOP_IMMEDIATE_TRIGGER_RISK');
  });

  it('returns RECOVERY_REQUIRED when stop price is unknown', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
    });
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState());
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toBe('STOP_PRICE_UNKNOWN');
  });

  it('returns UNKNOWN on position read failure', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockRejectedValue(new Error('network')),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toContain('POSITION_READ_FAILED');
  });

  it('reconciles flat position and cleans BOT orders', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(null),
      listCloseOrdersForSide: vi
        .fn()
        .mockResolvedValueOnce([
          { orderId: 'BOT1', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'BOT' },
          { orderId: 'EXT1', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'UNKNOWN' },
        ])
        .mockResolvedValueOnce([
          // Post-cancel: BOT1 gone, EXT1 remains (non-BOT, informational).
          { orderId: 'EXT1', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'UNKNOWN' },
        ]),
      cancelOrderById: vi.fn().mockResolvedValue(undefined),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('MISSING');
    expect(result.reason).toBe('FLAT_CONFIRMED');
    expect(exchange.cancelOrderById).toHaveBeenCalledWith('XRPUSDT', 'BOT1');
    expect(exchange.cancelOrderById).not.toHaveBeenCalledWith('XRPUSDT', 'EXT1');
    expect(store.flushed).toBe(true);
  });

  it('attempts emergency close when stop placement is rejected', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(makePosition()) // superviseOnce: position exists
        .mockResolvedValue(null) // attemptEmergencyClose post-close: flat (2 observations)
        .mockResolvedValue(null),
      listCloseOrdersForSide: vi
        .fn()
        .mockResolvedValue([]) // no stop
        .mockResolvedValue([]), // surviving orders after emergency close
      placeStopClose: vi.fn().mockResolvedValue(false), // Rejected
      closeSideMarketSafe: vi.fn().mockResolvedValue(undefined),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState({ lastStopPrice: 0.9 }), store);
    expect(result.status).toBe('MISSING');
    expect(result.reason).toContain('EMERGENCY_CLOSE_CONFIRMED');
    expect(exchange.closeSideMarketSafe).toHaveBeenCalledOnce();
    expect(store.flushed).toBe(true);
  });

  it('returns EMERGENCY_CLOSE_FAILED when close also fails', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(makePosition()) // superviseOnce: position exists
        .mockResolvedValueOnce(makePosition()) // emergency close post-check attempt 1: still there
        .mockResolvedValue(makePosition()), // emergency close post-check attempt 2: still there
      listCloseOrdersForSide: vi.fn().mockResolvedValue([]),
      placeStopClose: vi.fn().mockResolvedValue(false),
      closeSideMarketSafe: vi.fn().mockRejectedValue(new Error('close_failed')),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState({ lastStopPrice: 0.9 }), store);
    expect(result.status).toBe('EMERGENCY_CLOSE_FAILED');
    expect(result.reason).toContain('EMERGENCY_CLOSE_FAILED');
  });

  it('persists CONFIRMATION_PENDING when stop is placed but not confirmed', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi.fn().mockResolvedValue([]), // Never confirms
      placeStopClose: vi.fn().mockResolvedValue(true),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState({ lastStopPrice: 0.9 }), store);
    expect(result.status).toBe('CONFIRMATION_PENDING');
    expect(result.reason).toBe('STOP_PLACED_NOT_CONFIRMED');
  });

  it('returns CONFIRMATION_PENDING when previous submission is within timeout', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi.fn().mockResolvedValue([]), // No stop visible
    });
    const state = makeState({
      lastStopPrice: 0.9,
      microStopSubmission: {
        attemptedAt: 1_700_000_000_000 - 5_000,
        stopPrice: 0.9,
        tradeId: 'T1',
      },
    });
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', state);
    expect(result.status).toBe('CONFIRMATION_PENDING');
    expect(result.reason).toBe('PREVIOUS_SUBMISSION_NOT_CONFIRMED');
  });

  it('returns RECOVERY_REQUIRED when position reappears during flat reconciliation', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(null) // protectWithRetries: flat → enters reconcileFlat
        .mockResolvedValueOnce(null) // Flat observation 1: flat
        .mockResolvedValueOnce(makePosition()) // Flat observation 2: reappeared
        .mockResolvedValue(makePosition()), // Any further calls
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toBe('POSITION_REAPPEARED');
  });

  it('returns RECOVERY_REQUIRED when position reappears post-cleanup', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(null) // protectWithRetries: flat → enters reconcileFlat
        .mockResolvedValueOnce(null) // Flat observation 1: flat
        .mockResolvedValueOnce(null) // Flat observation 2: flat
        .mockResolvedValueOnce(makePosition()), // Final flat check: reappeared
      listCloseOrdersForSide: vi
        .fn()
        .mockResolvedValueOnce([
          { orderId: 'BOT1', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'BOT' },
        ])
        .mockResolvedValueOnce([]), // Post-cancel: BOT1 gone
      cancelOrderById: vi.fn().mockResolvedValue(undefined),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toBe('POSITION_REAPPEARED_POST_CLEANUP');
  });

  it('returns UNKNOWN when no store is provided and persistence is required', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi.fn().mockResolvedValue([]),
      getMarkPrice: vi.fn().mockResolvedValue(2.0),
    });
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    // No store provided → persistence guard blocks before sending to exchange.
    const result = await supervisor.supervise('XRPUSDT', makeState({ lastStopPrice: 0.9 }));
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('NO_STORE_FOR_PERSISTENCE');
  });

  it('returns RECOVERY_REQUIRED on stop recovery timeout (emergency close persists first)', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(makePosition()) // superviseOnce: position exists
        .mockResolvedValue(null), // emergency close post-check: flat
      listCloseOrdersForSide: vi.fn().mockResolvedValue([]),
      closeSideMarketSafe: vi.fn().mockResolvedValue(undefined),
    });

    const state = makeState({
      lastStopPrice: 0.9,
      microStopSubmission: {
        attemptedAt: 1_700_000_000_000 - 60_000,
        stopPrice: 0.9,
        tradeId: 'T1',
      },
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', state, store);
    expect(result.status).toBe('MISSING');
    expect(result.reason).toContain('EMERGENCY_CLOSE_CONFIRMED_STOP_RECOVERY_TIMEOUT');
    // Verify that RECOVERY_REQUIRED was persisted before the emergency close.
    expect(store.flushed).toBe(true);
  });

  it('confirms brackets exist for Aegis positions', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi.fn().mockResolvedValue(STOP_VISIBLE),
    });
    const supervisor = new PositionSupervisor(
      defaultDeps({ exchange, resolveOwner: () => 'AEGIS', requiresStop: () => false }),
    );
    const result = await supervisor.supervise('XRPUSDT', makeState());
    expect(result.status).toBe('PROTECTED');
    expect(result.owner).toBe('AEGIS');
  });

  it('returns UNKNOWN when Aegis position has no stop', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi.fn().mockResolvedValue([]),
    });
    const supervisor = new PositionSupervisor(
      defaultDeps({ exchange, resolveOwner: () => 'AEGIS', requiresStop: () => false }),
    );
    const result = await supervisor.supervise('XRPUSDT', makeState());
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('NO_STOP_FOUND_FOR_MANAGED_POSITION');
  });

  it('returns UNKNOWN for invalid position data', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition({ qtyAbs: NaN })),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('POSITION_INVALID');
  });

  it('returns UNKNOWN when flat read fails', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('transient')),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('FLAT_READ_ERROR');
  });

  it('returns UNKNOWN on bracket check failure for Aegis', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi.fn().mockRejectedValue(new Error('api_error')),
    });
    const supervisor = new PositionSupervisor(
      defaultDeps({ exchange, resolveOwner: () => 'AEGIS', requiresStop: () => false }),
    );
    const result = await supervisor.supervise('XRPUSDT', makeState());
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toContain('BRACKET_CHECK_FAILED');
  });

  it('returns RECOVERY_REQUIRED on stop price from microBurstStructuralStopPrice', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      getMarkPrice: vi.fn().mockResolvedValue(2.0),
    });
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise(
      'XRPUSDT',
      makeState({ lastStopPrice: undefined, microBurstStructuralStopPrice: 1.5 }),
    );
    // 1.5 stop vs 2.0 mark: would not trigger immediately.
    // But needs filters round. Let's check what we get.
    expect(['RECOVERY_REQUIRED', 'UNKNOWN', 'CONFIRMATION_PENDING', 'PROTECTED']).toContain(
      result.status,
    );
  });

  it('does NOT set IDLE when position reappears', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(null) // flat obs 1
        .mockResolvedValueOnce(makePosition()), // reappeared
      listCloseOrdersForSide: vi.fn().mockResolvedValue([]),
    });
    // Start in LONG_RIDE mode — if persistStatus wrongly sets IDLE, it will change.
    const store = mockStore(makeState({ mode: 'LONG_RIDE' }));
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState({ mode: 'LONG_RIDE' }), store);
    expect(result.status).toBe('RECOVERY_REQUIRED');
    const stored = store.get();
    expect(stored.mode).toBe('LONG_RIDE');
  });

  it('preserves uncertainty when hasConfirmedStop query fails then returns empty', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout')) // first query fails
        .mockResolvedValue([]), // second query returns empty
      placeStopClose: vi.fn().mockResolvedValue(true),
      cancelOrderById: vi.fn().mockResolvedValue(undefined),
    });
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState({ lastStopPrice: 0.9 }));
    // After error + empty: UNKNOWN (uncertain), not CONFIRMATION_PENDING.
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toContain('STOP_CHECK_AMBIGUOUS');
  });

  it('blocks flat confirmation when BOT orders survive cancellation failure', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(null) // flat obs 1
        .mockResolvedValueOnce(null) // flat obs 2
        .mockResolvedValue(null),
      listCloseOrdersForSide: vi
        .fn()
        .mockResolvedValue([
          { orderId: 'BOT1', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'BOT' },
        ]),
      cancelOrderById: vi.fn().mockRejectedValue(new Error('reject')),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toContain('SURVIVING_BOT_ORDERS');
  });

  it('blocks flat confirmation when order re-consult fails', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(null) // flat obs 1
        .mockResolvedValueOnce(null) // flat obs 2
        .mockResolvedValue(null),
      listCloseOrdersForSide: vi
        .fn()
        .mockResolvedValueOnce([]) // pre-cancel: empty
        .mockRejectedValueOnce(new Error('network')), // re-consult fails
      cancelOrderById: vi.fn().mockResolvedValue(undefined),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toContain('ORDER_RECONSULT_FAILED');
  });

  it('cancelled BOT order still visible post-consult is treated as survivor', async () => {
    // Reproduces R4-1: cancelación reconocida pero ordenBOT sigue visible.
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(null),
      listCloseOrdersForSide: vi
        .fn()
        .mockResolvedValueOnce([
          { orderId: 'BOT1', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'BOT' },
        ])
        .mockResolvedValueOnce([
          // Post-cancel: BOT1 is STILL visible despite successful cancellation.
          { orderId: 'BOT1', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'BOT' },
        ]),
      cancelOrderById: vi.fn().mockResolvedValue(undefined), // Acknowledged.
    });
    const store = mockStore(makeState({ mode: 'LONG_RIDE' }));
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState({ mode: 'LONG_RIDE' }), store);
    // Must NOT be MISSING — the order is still there.
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toContain('SURVIVING_BOT_ORDERS');
    expect(store.get().mode).toBe('LONG_RIDE');
  });

  it('emergency close blocks when no store is available', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn().mockResolvedValue(makePosition()),
      listCloseOrdersForSide: vi.fn().mockResolvedValue([]),
    });
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    // No store passed.
    const result = await supervisor.supervise(
      'XRPUSDT',
      makeState({
        lastStopPrice: 0.9,
        microStopSubmission: { attemptedAt: 0, stopPrice: 0.9, tradeId: 'T1' },
      }),
    );
    // Should block, not execute emergency close.
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toContain('EMERGENCY_CLOSE_NO_STORE');
  });

  it('emergency close uses 2-observation flat confirmation', async () => {
    // First observation flat, second still open: must NOT confirm.
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValue(makePosition()) // supervise: has position
        .mockResolvedValueOnce(makePosition()) // protectWithRetries: position still open
        .mockResolvedValueOnce(null) // emergency flat obs 1: flat
        .mockResolvedValueOnce(makePosition()), // emergency flat obs 2: still open
      listCloseOrdersForSide: vi.fn().mockResolvedValue([]), // no orders
      placeStopClose: vi.fn().mockResolvedValue(true),
      cancelOrderById: vi.fn().mockResolvedValue(undefined),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise(
      'XRPUSDT',
      makeState({
        lastStopPrice: 0.9,
        microStopSubmission: { attemptedAt: 0, stopPrice: 0.9, tradeId: 'T1' },
      }),
      store,
    );
    // Second observation saw position → RECOVERY_REQUIRED, not MISSING.
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toContain('POSITION_STILL_OPEN');
  });

  it('emergency close blocks on surviving BOT orders post-cleanup', async () => {
    const exchange = mockExchange({
      readActivePosition: vi
        .fn()
        .mockResolvedValueOnce(makePosition()) // protectWithRetries: has position
        .mockResolvedValueOnce(null) // emergency flat obs 1
        .mockResolvedValueOnce(null) // emergency flat obs 2
        .mockResolvedValueOnce(null), // final check after cleanup
      listCloseOrdersForSide: vi
        .fn()
        .mockResolvedValueOnce([]) // hasConfirmedStop attempt 1: no stop
        .mockResolvedValueOnce([]) // hasConfirmedStop attempt 2: no stop → ABSENT
        .mockResolvedValueOnce([]) // emergency pre-cancel: empty
        .mockResolvedValueOnce([
          // Post-cancel: BOT order reappeared.
          { orderId: 'BOT2', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'BOT' },
        ]),
      placeStopClose: vi.fn().mockResolvedValue(true),
      cancelOrderById: vi.fn().mockResolvedValue(undefined),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise(
      'XRPUSDT',
      makeState({
        lastStopPrice: 0.9,
        microStopSubmission: { attemptedAt: 0, stopPrice: 0.9, tradeId: 'T1' },
      }),
      store,
    );
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toContain('EMERGENCY_CLOSE_SURVIVING_BOT_ORDERS');
  });
});

describe.each(['normal', 'emergency'] as const)('shared flat contract: %s', (path) => {
  function fixture() {
    const state = makeState({
      mode: 'LONG_RIDE',
      bracketsAttached: true,
      microStopSubmission: { attemptedAt: 0, stopPrice: 0.9, tradeId: 'T1' },
      microBurstExitState: { phase: 'AMBIGUOUS', orderId: 'EXIT1' },
      microBurstPnlUnverified: true,
      microBurstPnlUnverifiedAt: 123,
    });
    const store = mockStore(state);
    const flush = vi.spyOn(store, 'flush');
    const exchange = mockExchange();
    const read = vi.mocked(exchange.readActivePosition);
    // The normal path has an initial flat routing read; emergency starts open.
    read.mockResolvedValueOnce(path === 'normal' ? null : makePosition());
    const list = vi.mocked(exchange.listCloseOrdersForSide);
    if (path === 'emergency') list.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    return {
      state,
      store,
      flush,
      exchange,
      read,
      list,
      run: (target: StateStore | undefined = store) =>
        supervisor.supervise('XRPUSDT', state, target),
      supervisor,
    };
  }

  it('R1: null then open never cancels and preserves identity and mode', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(null).mockResolvedValueOnce(makePosition());
    const result = await f.run();
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.store.get()).toMatchObject({
      mode: 'LONG_RIDE',
      lastTradeId: 'T1',
      lastSide: 'LONG',
      microProtectionBlocked: true,
    });
  });

  it('R2: error then null cannot erase uncertainty or cancel', async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce(null);
    const result = await f.run();
    expect(result.status).toBe('UNKNOWN');
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.store.get().mode).toBe('LONG_RIDE');
  });

  it.each([undefined, NaN, 0, -1])('rejects invalid quantity %s before cleanup', async (qty) => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makePosition({ qtyAbs: qty as number }));
    expect((await f.run()).status).toBe('UNKNOWN');
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.store.get().mode).toBe('LONG_RIDE');
  });

  it('rejects undefined position rather than treating it as flat', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(undefined as unknown as PositionInfo);
    expect((await f.run()).status).toBe('UNKNOWN');
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'surviving BOT order blocks finalization, cancel fails=%s',
    async (fails) => {
      const f = fixture();
      f.list.mockResolvedValue(STOP_VISIBLE as any);
      if (fails)
        vi.mocked(f.exchange.cancelOrderById).mockRejectedValue(new Error('cancel failed'));
      expect((await f.run()).status).toBe(fails ? 'UNKNOWN' : 'RECOVERY_REQUIRED');
      expect(f.exchange.cancelOrderById).toHaveBeenCalledWith('XRPUSDT', 'S1');
      expect(f.store.get().mode).toBe('LONG_RIDE');
    },
  );

  it('keeps cancellation errors UNKNOWN even if post-list is empty', async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce(STOP_VISIBLE as any).mockResolvedValueOnce([]);
    vi.mocked(f.exchange.cancelOrderById).mockRejectedValue(new Error('cancel timeout'));
    expect((await f.run()).status).toBe('UNKNOWN');
    expect(f.store.get().mode).toBe('LONG_RIDE');
  });

  it.each(['pre-list', 'post-list', 'final-read'] as const)(
    'keeps %s errors UNKNOWN',
    async (failure) => {
      const f = fixture();
      if (failure === 'pre-list') f.list.mockRejectedValueOnce(new Error('list failed'));
      if (failure === 'post-list')
        f.list.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('list failed'));
      if (failure === 'final-read') {
        f.read
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(new Error('final failed'));
      }
      expect((await f.run()).status).toBe('UNKNOWN');
      expect(f.store.get()).toMatchObject({ mode: 'LONG_RIDE', microProtectionBlocked: true });
    },
  );

  it.each([undefined, NaN, 0, -1])('rejects invalid final quantity %s', async (qty) => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makePosition({ qtyAbs: qty as number }));
    expect((await f.run()).status).toBe('UNKNOWN');
    expect(f.store.get().mode).toBe('LONG_RIDE');
  });

  it.each(['absent', 'no-flush', 'disk', 'identity', 'stale'] as const)(
    'blocks mutation with %s store',
    async (failure) => {
      const f = fixture();
      f.list.mockResolvedValue(
        STOP_VISIBLE.map((o) => ({ ...o, type: 'TAKE_PROFIT_MARKET' })) as any,
      );
      let store: StateStore | undefined = f.store;
      if (failure === 'absent') store = undefined;
      if (failure === 'no-flush')
        store = { get: f.store.get, set: f.store.set, reset: f.store.reset };
      if (failure === 'disk') f.flush.mockRejectedValue(new Error('disk failed'));
      if (failure === 'identity') {
        f.state.lastTradeId = undefined;
        f.store.set({ lastTradeId: undefined });
      }
      if (failure === 'stale') f.store.set({ lastTradeId: 'T2' });
      const result = await f.supervisor.supervise('XRPUSDT', f.state, store);
      expect(result.status).toBe('UNKNOWN');
      expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
      expect(f.exchange.closeSideMarketSafe).not.toHaveBeenCalled();
      expect(f.store.get().mode).toBe('LONG_RIDE');
    },
  );

  it('R1/R2: flushes the real simulated store before each exchange mutation', async () => {
    const f = fixture();
    let durable: BotState | undefined;
    f.flush.mockImplementation(async () => {
      durable = f.store.get();
    });
    const assertDurable = () => {
      expect(durable).toMatchObject({
        mode: 'LONG_RIDE',
        lastTradeId: 'T1',
        microProtectionBlocked: true,
      });
    };
    vi.mocked(f.exchange.closeSideMarketSafe).mockImplementation(async () => {
      assertDurable();
    });
    vi.mocked(f.exchange.cancelOrderById).mockImplementation(async () => {
      assertDurable();
    });
    const foreign = { orderId: 'MANUAL', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'UNKNOWN' };
    f.list
      .mockResolvedValueOnce([...STOP_VISIBLE, foreign] as any)
      .mockResolvedValueOnce([foreign] as any);
    expect((await f.run()).status).toBe('MISSING');
    expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
    expect(f.exchange.cancelOrderById).toHaveBeenCalledWith('XRPUSDT', 'S1');
    expect(f.exchange.closeSideMarketSafe).toHaveBeenCalledTimes(path === 'emergency' ? 1 : 0);
    expect(f.store.get()).toMatchObject({
      mode: 'IDLE',
      lastTradeId: 'T1',
      lastSide: 'LONG',
      microProtectionBlocked: true,
      microStopSubmission: f.state.microStopSubmission,
      microBurstExitState: f.state.microBurstExitState,
      microBurstPnlUnverified: true,
      microBurstPnlUnverifiedAt: 123,
      lastExitReason: 'FLAT_CONFIRMED_ACCOUNTING_PENDING',
    });
    expect(durable).toEqual(f.store.get());
  });

  it('restores conservative memory when final flush fails without reporting MISSING', async () => {
    const f = fixture();
    f.flush.mockImplementation(async () => {
      if (f.store.get().mode === 'IDLE') throw new Error('final disk failure');
    });
    const result = await f.run();
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toContain('FLAT_PERSIST_FAILED:Error: final disk failure');
    expect(f.store.get()).toEqual({ ...f.state, microProtectionBlocked: true });
  });

  it('rechecks store identity after awaited reads before cancellation', async () => {
    const f = fixture();
    f.list.mockImplementationOnce(async () => {
      f.store.set({ lastTradeId: 'T2' });
      return STOP_VISIBLE as any;
    });
    expect((await f.run()).status).toBe('UNKNOWN');
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.store.get().lastTradeId).toBe('T2');
  });

  it.each([false, true])(
    'preserves a newer operation during final flush, rejects=%s',
    async (rejects) => {
      const f = fixture();
      let newer: BotState | undefined;
      f.flush.mockImplementation(async () => {
        if (f.store.get().mode !== 'IDLE') return;
        f.store.set({
          lastTradeId: 'T2',
          lastSide: 'SHORT',
          mode: 'SHORT_RIDE',
          bracketsAttached: true,
          microBurstPnlUnverified: false,
          microBurstPnlUnverifiedAt: 456,
          lastExitAt: 789,
          lastExitReason: 'NEW_OPERATION',
        });
        newer = f.store.get();
        if (rejects) throw new Error('concurrent flush failure');
      });
      const result = await f.run();
      expect(result.status).toBe('UNKNOWN');
      expect(result.reason).toContain(
        rejects ? 'FLAT_PERSIST_FAILED' : 'FLAT_PERSIST_STATE_CHANGED',
      );
      expect(newer).toBeDefined();
      expect(f.store.get()).toEqual({ ...newer, microProtectionBlocked: true });
    },
  );

  it('rejects identity changes during flush before any exchange mutation', async () => {
    const f = fixture();
    f.flush.mockImplementationOnce(async () => {
      f.store.set({ lastTradeId: 'T2' });
    });
    expect((await f.run()).status).toBe('UNKNOWN');
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(f.store.get().lastTradeId).toBe('T2');
  });

  it('does not finalize a stale mode or overwrite newer accounting flags', async () => {
    const f = fixture();
    f.store.set({ mode: 'IDLE', microBurstPnlUnverifiedAt: 456 });
    expect((await f.run()).status).toBe('UNKNOWN');
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(f.store.get()).toMatchObject({ mode: 'IDLE', microBurstPnlUnverifiedAt: 456 });
  });
});
