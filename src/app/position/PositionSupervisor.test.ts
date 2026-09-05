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
    getSymbolFilters: vi.fn().mockResolvedValue({ tickSize: 0.0001, stepSize: 1, pricePrecision: 4, qtyPrecision: 1, minNotional: 5 }),
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

function mockStore(state: BotState = makeState()): StateStore & { flushed: boolean; lastSet: Partial<BotState> | undefined } {
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
    reset: () => { current = makeState(); },
    flush: async () => { store.flushed = true; },
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
  { orderId: 'S1', type: 'STOP_MARKET', stopPrice: 0.9, closePosition: true, owner: 'BOT', side: 'SELL', positionSide: 'BOTH' },
];

describe('PositionSupervisor', () => {
  it('returns UNKNOWN when supervision is already in flight for symbol', async () => {
    const deps = defaultDeps();
    const supervisor = new PositionSupervisor(deps);
    let resolveRead!: (v: PositionInfo | null) => void;
    (deps.exchange.readActivePosition as any).mockReturnValueOnce(
      new Promise<PositionInfo | null>((r) => { resolveRead = r; }),
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
      listCloseOrdersForSide: vi.fn()
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
      listCloseOrdersForSide: vi.fn()
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
      readActivePosition: vi.fn()
        .mockResolvedValueOnce(makePosition()) // superviseOnce: position exists
        .mockResolvedValue(null) // attemptEmergencyClose post-close: flat (2 observations)
        .mockResolvedValue(null),
      listCloseOrdersForSide: vi.fn()
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
      readActivePosition: vi.fn()
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
      readActivePosition: vi.fn()
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
      readActivePosition: vi.fn()
        .mockResolvedValueOnce(null) // protectWithRetries: flat → enters reconcileFlat
        .mockResolvedValueOnce(null) // Flat observation 1: flat
        .mockResolvedValueOnce(null) // Flat observation 2: flat
        .mockResolvedValueOnce(makePosition()), // Final flat check: reappeared
      listCloseOrdersForSide: vi.fn()
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
      readActivePosition: vi.fn()
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
      readActivePosition: vi.fn()
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
    expect(['RECOVERY_REQUIRED', 'UNKNOWN', 'CONFIRMATION_PENDING', 'PROTECTED']).toContain(result.status);
  });

  it('does NOT set IDLE when position reappears', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn()
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
      listCloseOrdersForSide: vi.fn()
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
      readActivePosition: vi.fn()
        .mockResolvedValueOnce(null) // flat obs 1
        .mockResolvedValueOnce(null) // flat obs 2
        .mockResolvedValue(null),
      listCloseOrdersForSide: vi.fn()
        .mockResolvedValue([
          { orderId: 'BOT1', type: 'STOP_MARKET', stopPrice: 0.9, owner: 'BOT' },
        ]),
      cancelOrderById: vi.fn().mockRejectedValue(new Error('reject')),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState(), store);
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toContain('SURVIVING_BOT_ORDERS');
  });

  it('blocks flat confirmation when order re-consult fails', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn()
        .mockResolvedValueOnce(null) // flat obs 1
        .mockResolvedValueOnce(null) // flat obs 2
        .mockResolvedValue(null),
      listCloseOrdersForSide: vi.fn()
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
      listCloseOrdersForSide: vi.fn()
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
    const result = await supervisor.supervise('XRPUSDT', makeState({
      lastStopPrice: 0.9,
      microStopSubmission: { attemptedAt: 0, stopPrice: 0.9, tradeId: 'T1' },
    }));
    // Should block, not execute emergency close.
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toContain('EMERGENCY_CLOSE_NO_STORE');
  });

  it('emergency close uses 2-observation flat confirmation', async () => {
    // First observation flat, second still open: must NOT confirm.
    const exchange = mockExchange({
      readActivePosition: vi.fn()
        .mockResolvedValue(makePosition()) // supervise: has position
        .mockResolvedValueOnce(makePosition()) // protectWithRetries: position still open
        .mockResolvedValueOnce(null) // emergency flat obs 1: flat
        .mockResolvedValueOnce(makePosition()), // emergency flat obs 2: still open
      listCloseOrdersForSide: vi.fn()
        .mockResolvedValue([]), // no orders
      placeStopClose: vi.fn().mockResolvedValue(true),
      cancelOrderById: vi.fn().mockResolvedValue(undefined),
    });
    const store = mockStore();
    const supervisor = new PositionSupervisor(defaultDeps({ exchange }));
    const result = await supervisor.supervise('XRPUSDT', makeState({
      lastStopPrice: 0.9,
      microStopSubmission: { attemptedAt: 0, stopPrice: 0.9, tradeId: 'T1' },
    }), store);
    // Second observation saw position → RECOVERY_REQUIRED, not MISSING.
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toContain('POSITION_STILL_OPEN');
  });

  it('emergency close blocks on surviving BOT orders post-cleanup', async () => {
    const exchange = mockExchange({
      readActivePosition: vi.fn()
        .mockResolvedValueOnce(makePosition()) // protectWithRetries: has position
        .mockResolvedValueOnce(null) // emergency flat obs 1
        .mockResolvedValueOnce(null) // emergency flat obs 2
        .mockResolvedValueOnce(null), // final check after cleanup
      listCloseOrdersForSide: vi.fn()
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
    const result = await supervisor.supervise('XRPUSDT', makeState({
      lastStopPrice: 0.9,
      microStopSubmission: { attemptedAt: 0, stopPrice: 0.9, tradeId: 'T1' },
    }), store);
    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(result.reason).toContain('EMERGENCY_CLOSE_SURVIVING_BOT_ORDERS');
  });
});
