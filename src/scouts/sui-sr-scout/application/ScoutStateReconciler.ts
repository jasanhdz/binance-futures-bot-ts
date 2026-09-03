import type { Side } from '../../../core/types';
import type { ScoutPositionState } from '../domain/ScoutTypes';

export interface ScoutReadOnlyExchangePort {
  readActivePosition(
    symbol: string,
    sideHint: Side,
  ): Promise<{ qtyAbs: number; sideMode: 'BOTH' | 'LONG' | 'SHORT' } | null>;
  listCloseOrdersForSide(
    symbol: string,
    side: Side,
  ): Promise<Array<{ type: string; orderId: string }>>;
  getRecentFills(
    symbol: string,
    startTime?: number,
    limit?: number,
  ): Promise<Array<{ orderId: string; qty: number }>>;
}

export interface ScoutStateReconciler {
  reconcile(): Promise<ScoutPositionState>;
  getState(): ScoutPositionState;
}

const UNKNOWN: ScoutPositionState = {
  status: 'UNKNOWN',
  checkedAtMs: 0,
  openPositionCount: 0,
  openOrderCount: 0,
  stopConfirmed: false,
  reason: 'not_reconciled',
};

/** Read-only account reconciliation. It owns no mutation capability. */
export function createScoutStateReconciler(
  port: ScoutReadOnlyExchangePort | null,
): ScoutStateReconciler {
  let state = UNKNOWN;

  return {
    async reconcile(): Promise<ScoutPositionState> {
      if (!port)
        return (state = {
          ...UNKNOWN,
          checkedAtMs: Date.now(),
          reason: 'read_only_port_unavailable',
        });
      try {
        const [long, short, longOrders, shortOrders] = await Promise.all([
          port.readActivePosition('SUIUSDT', 'LONG'),
          port.readActivePosition('SUIUSDT', 'SHORT'),
          port.listCloseOrdersForSide('SUIUSDT', 'LONG'),
          port.listCloseOrdersForSide('SUIUSDT', 'SHORT'),
        ]);
        const positions = [long, short].filter((position) => position && position.qtyAbs > 0);
        if (positions.length > 1) {
          return (state = {
            status: 'UNKNOWN',
            checkedAtMs: Date.now(),
            openPositionCount: positions.length,
            openOrderCount: longOrders.length + shortOrders.length,
            stopConfirmed: false,
            reason: 'multiple_sui_positions_detected',
          });
        }
        if (positions.length === 0) {
          return (state = {
            status: 'CONFIRMED_FLAT',
            checkedAtMs: Date.now(),
            openPositionCount: 0,
            openOrderCount: longOrders.length + shortOrders.length,
            stopConfirmed: false,
            reason: null,
          });
        }
        const activeSide: Side = long?.qtyAbs ? 'LONG' : 'SHORT';
        const stopConfirmed = (activeSide === 'LONG' ? longOrders : shortOrders).some(
          (order) => order.type === 'STOP' || order.type === 'STOP_MARKET',
        );
        return (state = {
          status: stopConfirmed ? 'CONFIRMED_OPEN' : 'UNPROTECTED',
          checkedAtMs: Date.now(),
          openPositionCount: 1,
          openOrderCount: longOrders.length + shortOrders.length,
          stopConfirmed,
          reason: stopConfirmed ? null : 'protective_stop_not_confirmed',
        });
      } catch (error) {
        return (state = {
          ...UNKNOWN,
          checkedAtMs: Date.now(),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
    getState(): ScoutPositionState {
      return state;
    },
  };
}
