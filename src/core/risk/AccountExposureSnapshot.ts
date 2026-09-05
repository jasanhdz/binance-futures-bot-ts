import { Side } from '../../core/types';

export interface USDTAccountSnapshot {
  walletBalance?: number;
  availableBalance?: number;
  unrealizedPnlTotal?: number;
  equityTotal?: number;
}

export type SnapshotCompleteness = 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';

export interface PositionSnapshot {
  symbol: string;
  side: Side;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  qtyAbs: number;
  entryPrice: number;
  leverage: number;
  unrealizedPnl?: number;
  /** Whether this position is in the configured symbol list. */
  inConfig: boolean;
  /** Strategy that owns this position, if determinable. */
  owner?: 'MICRO' | 'AEGIS' | 'MOMENTUM' | 'EXTERNAL' | 'UNKNOWN';
}

export interface PendingOrderSnapshot {
  symbol: string;
  side: Side;
  type: string;
  orderId: string;
  stopPrice?: number;
  quantity?: number;
  owner?: 'BOT' | 'UNKNOWN';
}

export interface MarginReservation {
  symbol: string;
  reservedBy: string;
  notionalEstimate: number;
  timestampMs: number;
}

export interface AccountExposureSnapshot {
  completeness: SnapshotCompleteness;
  timestampMs: number;
  account: USDTAccountSnapshot;
  positions: PositionSnapshot[];
  pendingOrders: PendingOrderSnapshot[];
  reservations: MarginReservation[];
  /** Total notional exposure across all positions. */
  totalExposureNotional: number;
  /** Available margin after existing positions and reservations. */
  availableMargin: number;
  /** Reason for partial/unknown completeness. */
  incompleteReason?: string;
}

export interface ExposureSnapshotDeps {
  getAccountSnapshot(): Promise<USDTAccountSnapshot>;
  getAllPositions(): Promise<PositionSnapshot[]>;
  getAllPendingOrders(): Promise<PendingOrderSnapshot[]>;
  getReservations(): MarginReservation[];
  now?: () => number;
}

/**
 * Build a complete account exposure snapshot.
 * Deduplicates positions by symbol+positionSide (BOTH counted once).
 * Validates all numeric fields are finite and non-negative where required.
 */
export async function buildAccountExposureSnapshot(
  deps: ExposureSnapshotDeps,
): Promise<AccountExposureSnapshot> {
  const nowMs = deps.now?.() ?? Date.now();
  const reasons: string[] = [];

  // 1. Account snapshot.
  let account: USDTAccountSnapshot;
  try {
    account = await deps.getAccountSnapshot();
    if (!isValidAccountSnapshot(account)) {
      reasons.push('account_snapshot_invalid');
      account = {};
    }
  } catch (error) {
    reasons.push(`account_snapshot_error:${String(error)}`);
    account = {};
  }

  // 2. Positions.
  let positions: PositionSnapshot[];
  try {
    positions = await deps.getAllPositions();
    positions = deduplicatePositions(positions);
    const invalidPositions = positions.filter(
      (p) => !Number.isFinite(p.qtyAbs) || !Number.isFinite(p.entryPrice) || p.entryPrice <= 0,
    );
    if (invalidPositions.length > 0) {
      reasons.push('invalid_positions_filtered');
      positions = positions.filter(
        (p) => Number.isFinite(p.qtyAbs) && Number.isFinite(p.entryPrice) && p.entryPrice > 0,
      );
    }
  } catch (error) {
    reasons.push(`positions_error:${String(error)}`);
    positions = [];
  }

  // 3. Pending orders.
  let pendingOrders: PendingOrderSnapshot[];
  try {
    pendingOrders = await deps.getAllPendingOrders();
  } catch (error) {
    reasons.push(`pending_orders_error:${String(error)}`);
    pendingOrders = [];
  }

  // 4. Reservations.
  const reservations = deps.getReservations().filter(
    (r) => Number.isFinite(r.notionalEstimate) && r.notionalEstimate >= 0,
  );

  // 5. Compute totals.
  const totalExposureNotional = positions.reduce(
    (sum, p) => sum + p.qtyAbs * p.entryPrice,
    0,
  );
  const walletBalance = account.walletBalance ?? 0;
  const unrealizedPnl = account.unrealizedPnlTotal ?? 0;
  const reservedNotional = reservations.reduce((sum, r) => sum + r.notionalEstimate, 0);
  const availableMargin = walletBalance + unrealizedPnl - reservedNotional;

  const completeness: SnapshotCompleteness =
    reasons.length === 0 ? 'COMPLETE' : reasons.some((r) => r.includes('error')) ? 'UNKNOWN' : 'PARTIAL';

  return {
    completeness,
    timestampMs: nowMs,
    account,
    positions,
    pendingOrders,
    reservations,
    totalExposureNotional,
    availableMargin,
    incompleteReason: reasons.length > 0 ? reasons.join('; ') : undefined,
  };
}

/**
 * Check if admission should be denied based on exposure snapshot.
 */
export function shouldDenyAdmission(
  snapshot: AccountExposureSnapshot,
  intendedSymbol: string,
  intendedNotional: number,
  maxExposurePct = 0.95,
): { denied: boolean; reason?: string } {
  if (snapshot.completeness === 'UNKNOWN') {
    return { denied: true, reason: 'EXPOSURE_UNKNOWN' };
  }
  if (snapshot.completeness === 'PARTIAL') {
    return { denied: true, reason: 'EXPOSURE_INCOMPLETE' };
  }
  if (!Number.isFinite(intendedNotional) || intendedNotional <= 0) {
    return { denied: true, reason: 'INVALID_INTENDED_NOTIONAL' };
  }
  if (snapshot.availableMargin < intendedNotional) {
    return { denied: true, reason: 'INSUFFICIENT_MARGIN' };
  }
  const projectedExposure = snapshot.totalExposureNotional + intendedNotional;
  const walletBalance = snapshot.account.walletBalance ?? 0;
  if (walletBalance > 0 && projectedExposure / walletBalance > maxExposurePct) {
    return { denied: true, reason: 'EXPOSURE_LIMIT_EXCEEDED' };
  }
  // Check for incompatible existing position.
  const existing = snapshot.positions.find((p) => p.symbol === intendedSymbol);
  if (existing && existing.qtyAbs > 0) {
    return { denied: true, reason: 'POSITION_ALREADY_OPEN' };
  }
  return { denied: false };
}

function isValidAccountSnapshot(snapshot: USDTAccountSnapshot): boolean {
  if (snapshot.walletBalance !== undefined && (!Number.isFinite(snapshot.walletBalance) || snapshot.walletBalance < 0)) {
    return false;
  }
  if (snapshot.availableBalance !== undefined && !Number.isFinite(snapshot.availableBalance)) {
    return false;
  }
  if (snapshot.unrealizedPnlTotal !== undefined && !Number.isFinite(snapshot.unrealizedPnlTotal)) {
    return false;
  }
  return true;
}

function deduplicatePositions(positions: PositionSnapshot[]): PositionSnapshot[] {
  const bySymbol = new Map<string, PositionSnapshot[]>();
  for (const p of positions) {
    const list = bySymbol.get(p.symbol) ?? [];
    list.push(p);
    bySymbol.set(p.symbol, list);
  }

  const result: PositionSnapshot[] = [];
  for (const [, list] of bySymbol) {
    if (list.length === 1) {
      result.push(list[0]);
      continue;
    }
    // In hedge mode, LONG and SHORT can coexist. Only deduplicate BOTH with a specific side.
    const bothPositions = list.filter((p) => p.positionSide === 'BOTH');
    const specificPositions = list.filter((p) => p.positionSide !== 'BOTH');
    if (bothPositions.length > 0 && specificPositions.length > 0) {
      // BOTH exists with specific side(s): drop BOTH, keep specifics.
      result.push(...specificPositions);
    } else if (bothPositions.length > 1) {
      // Multiple BOTH: keep first.
      result.push(bothPositions[0]);
    } else {
      // All specific sides (e.g., LONG + SHORT in hedge): keep all.
      result.push(...list);
    }
  }
  return result;
}
