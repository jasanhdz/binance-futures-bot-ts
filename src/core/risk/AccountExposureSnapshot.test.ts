import { describe, expect, it, vi } from 'vitest';
import {
  AccountExposureSnapshot,
  buildAccountExposureSnapshot,
  shouldDenyAdmission,
  ExposureSnapshotDeps,
  PositionSnapshot,
  PendingOrderSnapshot,
} from './AccountExposureSnapshot';

function mockDeps(overrides: Partial<ExposureSnapshotDeps> = {}): ExposureSnapshotDeps {
  return {
    getAccountSnapshot: vi.fn().mockResolvedValue({
      walletBalance: 1000,
      availableBalance: 800,
      unrealizedPnlTotal: 50,
    }),
    getAllPositions: vi.fn().mockResolvedValue([]),
    getAllPendingOrders: vi.fn().mockResolvedValue([]),
    getReservations: vi.fn().mockReturnValue([]),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    symbol: 'XRPUSDT',
    side: 'LONG',
    positionSide: 'BOTH',
    qtyAbs: 100,
    entryPrice: 1.0,
    leverage: 20,
    inConfig: true,
    ...overrides,
  };
}

describe('buildAccountExposureSnapshot', () => {
  it('returns COMPLETE with empty positions', async () => {
    const snapshot = await buildAccountExposureSnapshot(mockDeps());
    expect(snapshot.completeness).toBe('COMPLETE');
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.totalExposureNotional).toBe(0);
    expect(snapshot.availableMargin).toBe(1050); // 1000 + 50 - 0
  });

  it('computes total exposure from positions', async () => {
    const deps = mockDeps({
      getAllPositions: vi.fn().mockResolvedValue([
        makePosition({ symbol: 'XRPUSDT', qtyAbs: 100, entryPrice: 1.0 }),
        makePosition({ symbol: 'BTCUSDT', qtyAbs: 0.1, entryPrice: 60000, side: 'SHORT', positionSide: 'SHORT' }),
      ]),
    });
    const snapshot = await buildAccountExposureSnapshot(deps);
    expect(snapshot.totalExposureNotional).toBeCloseTo(100 * 1.0 + 0.1 * 60000);
    expect(snapshot.positions).toHaveLength(2);
  });

  it('deduplicates BOTH alongside LONG', async () => {
    const deps = mockDeps({
      getAllPositions: vi.fn().mockResolvedValue([
        makePosition({ symbol: 'XRPUSDT', positionSide: 'BOTH', qtyAbs: 100 }),
        makePosition({ symbol: 'XRPUSDT', positionSide: 'LONG', qtyAbs: 100 }),
      ]),
    });
    const snapshot = await buildAccountExposureSnapshot(deps);
    // LONG should replace BOTH.
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0].positionSide).toBe('LONG');
  });

  it('deduplicates LONG alongside SHORT (different sides)', async () => {
    const deps = mockDeps({
      getAllPositions: vi.fn().mockResolvedValue([
        makePosition({ symbol: 'XRPUSDT', positionSide: 'LONG', qtyAbs: 100 }),
        makePosition({ symbol: 'XRPUSDT', positionSide: 'SHORT', qtyAbs: 50 }),
      ]),
    });
    const snapshot = await buildAccountExposureSnapshot(deps);
    // Both kept since they have different positionSide keys.
    expect(snapshot.positions).toHaveLength(2);
  });

  it('filters invalid positions and sets PARTIAL', async () => {
    const deps = mockDeps({
      getAllPositions: vi.fn().mockResolvedValue([
        makePosition({ symbol: 'XRPUSDT', qtyAbs: 100, entryPrice: 1.0 }),
        makePosition({ symbol: 'BTCUSDT', qtyAbs: NaN, entryPrice: 60000 }),
      ]),
    });
    const snapshot = await buildAccountExposureSnapshot(deps);
    expect(snapshot.completeness).toBe('PARTIAL');
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0].symbol).toBe('XRPUSDT');
  });

  it('returns UNKNOWN on account snapshot error', async () => {
    const deps = mockDeps({
      getAccountSnapshot: vi.fn().mockRejectedValue(new Error('api_down')),
    });
    const snapshot = await buildAccountExposureSnapshot(deps);
    expect(snapshot.completeness).toBe('UNKNOWN');
    expect(snapshot.account).toEqual({});
  });

  it('returns UNKNOWN on positions error', async () => {
    const deps = mockDeps({
      getAllPositions: vi.fn().mockRejectedValue(new Error('network')),
    });
    const snapshot = await buildAccountExposureSnapshot(deps);
    expect(snapshot.completeness).toBe('UNKNOWN');
    expect(snapshot.positions).toEqual([]);
  });

  it('includes reservations in available margin', async () => {
    const deps = mockDeps({
      getReservations: vi.fn().mockReturnValue([
        { symbol: 'ETHUSDT', reservedBy: 'entry_1', notionalEstimate: 200, timestampMs: 1_000 },
      ]),
    });
    const snapshot = await buildAccountExposureSnapshot(deps);
    expect(snapshot.availableMargin).toBeCloseTo(1050 - 200);
    expect(snapshot.reservations).toHaveLength(1);
  });

  it('filters invalid account snapshot fields', async () => {
    const deps = mockDeps({
      getAccountSnapshot: vi.fn().mockResolvedValue({
        walletBalance: NaN,
        availableBalance: 800,
      }),
    });
    const snapshot = await buildAccountExposureSnapshot(deps);
    expect(snapshot.completeness).toBe('PARTIAL');
  });

  it('includes pending orders', async () => {
    const deps = mockDeps({
      getAllPendingOrders: vi.fn().mockResolvedValue([
        { symbol: 'XRPUSDT', side: 'LONG', type: 'STOP_MARKET', orderId: 'S1', stopPrice: 0.9, owner: 'BOT' },
      ]),
    });
    const snapshot = await buildAccountExposureSnapshot(deps);
    expect(snapshot.pendingOrders).toHaveLength(1);
    expect(snapshot.pendingOrders[0].orderId).toBe('S1');
  });
});

describe('shouldDenyAdmission', () => {
  const baseSnapshot: AccountExposureSnapshot = {
    completeness: 'COMPLETE',
    timestampMs: 1_700_000_000_000,
    account: { walletBalance: 1000, availableBalance: 800, unrealizedPnlTotal: 50 },
    positions: [],
    pendingOrders: [],
    reservations: [],
    totalExposureNotional: 0,
    availableMargin: 1050,
  };

  it('allows admission with sufficient margin', () => {
    expect(shouldDenyAdmission(baseSnapshot, 'XRPUSDT', 100)).toEqual({ denied: false });
  });

  it('denies when exposure is UNKNOWN', () => {
    const snapshot = { ...baseSnapshot, completeness: 'UNKNOWN' as const };
    expect(shouldDenyAdmission(snapshot, 'XRPUSDT', 100)).toEqual({
      denied: true,
      reason: 'EXPOSURE_UNKNOWN',
    });
  });

  it('denies when exposure is PARTIAL', () => {
    const snapshot = { ...baseSnapshot, completeness: 'PARTIAL' as const };
    expect(shouldDenyAdmission(snapshot, 'XRPUSDT', 100)).toEqual({
      denied: true,
      reason: 'EXPOSURE_INCOMPLETE',
    });
  });

  it('denies when margin is insufficient', () => {
    expect(shouldDenyAdmission(baseSnapshot, 'XRPUSDT', 2000)).toEqual({
      denied: true,
      reason: 'INSUFFICIENT_MARGIN',
    });
  });

  it('denies when position already open', () => {
    const snapshot = {
      ...baseSnapshot,
      positions: [makePosition({ symbol: 'XRPUSDT', qtyAbs: 100 })],
    };
    expect(shouldDenyAdmission(snapshot, 'XRPUSDT', 100)).toEqual({
      denied: true,
      reason: 'POSITION_ALREADY_OPEN',
    });
  });

  it('denies when intended notional is invalid', () => {
    expect(shouldDenyAdmission(baseSnapshot, 'XRPUSDT', NaN)).toEqual({
      denied: true,
      reason: 'INVALID_INTENDED_NOTIONAL',
    });
    expect(shouldDenyAdmission(baseSnapshot, 'XRPUSDT', -100)).toEqual({
      denied: true,
      reason: 'INVALID_INTENDED_NOTIONAL',
    });
  });

  it('denies when exposure limit exceeded', () => {
    expect(shouldDenyAdmission(baseSnapshot, 'XRPUSDT', 1000, 0.5)).toEqual({
      denied: true,
      reason: 'EXPOSURE_LIMIT_EXCEEDED',
    });
  });

  it('allows admission for different symbol when one is open', () => {
    const snapshot = {
      ...baseSnapshot,
      positions: [makePosition({ symbol: 'XRPUSDT', qtyAbs: 100 })],
    };
    expect(shouldDenyAdmission(snapshot, 'BTCUSDT', 100)).toEqual({ denied: false });
  });
});
