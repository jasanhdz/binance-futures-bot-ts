import { describe, expect, it } from 'vitest';
import { createScoutStateReconciler, type ScoutReadOnlyExchangePort } from './ScoutStateReconciler';

function port(overrides: Partial<ScoutReadOnlyExchangePort> = {}): ScoutReadOnlyExchangePort {
  return {
    async readActivePosition() {
      return null;
    },
    async listCloseOrdersForSide() {
      return [];
    },
    async getRecentFills() {
      return [];
    },
    ...overrides,
  };
}

describe('ScoutStateReconciler', () => {
  it('fails closed when account reconciliation is unavailable', async () => {
    const reconciler = createScoutStateReconciler(null);
    expect((await reconciler.reconcile()).status).toBe('UNKNOWN');
  });

  it('reports an unprotected SUI position as non-tradeable', async () => {
    const reconciler = createScoutStateReconciler(
      port({
        async readActivePosition(_symbol, side) {
          return side === 'LONG' ? { qtyAbs: 10, sideMode: 'BOTH' } : null;
        },
      }),
    );
    const state = await reconciler.reconcile();
    expect(state.status).toBe('UNPROTECTED');
    expect(state.stopConfirmed).toBe(false);
  });

  it('confirms a single protected SUI position', async () => {
    const reconciler = createScoutStateReconciler(
      port({
        async readActivePosition(_symbol, side) {
          return side === 'LONG' ? { qtyAbs: 10, sideMode: 'BOTH' } : null;
        },
        async listCloseOrdersForSide(_symbol, side) {
          return side === 'LONG' ? [{ type: 'STOP_MARKET', orderId: 'stop-1' }] : [];
        },
      }),
    );
    expect((await reconciler.reconcile()).status).toBe('CONFIRMED_OPEN');
  });
});
