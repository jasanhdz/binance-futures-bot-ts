import { describe, expect, it } from 'vitest';
import { BotState } from '../types';
import { resolveStrategyOwnership } from './StrategyPositionOwnership';

function state(overrides: Partial<BotState>): BotState {
  return { mode: 'LONG_RIDE', ...overrides };
}

describe('resolveStrategyOwnership', () => {
  it.each(['MICRO-BURST-V1-ETHUSDT-1', 'MICRO-BURST-ETHUSDT-1'])(
    'normalizes persisted Micro provenance without rewriting %s or adopting manual ownership',
    (lastTradeId) => {
      const persisted = state({
        positionOwner: 'BOT',
        tradeOrigin: 'BOT',
        lastStrategy: 'MICRO_BURST_V1',
        lastTradeId,
      } as unknown as Partial<BotState>);
      const before = JSON.stringify(persisted);
      expect(resolveStrategyOwnership(persisted)).toEqual({
        status: 'OWNED',
        strategyId: 'MICRO_BURST',
      });
      expect(JSON.stringify(persisted)).toBe(before);
      expect(
        resolveStrategyOwnership({
          ...persisted,
          positionOwner: 'EXTERNAL',
          tradeOrigin: 'MANUAL_EXTERNAL',
        }),
      ).toEqual({ status: 'EXTERNAL' });
    },
  );
  it('resolves canonical BOT ownership from consistent strategy provenance', () => {
    expect(
      resolveStrategyOwnership(
        state({
          positionOwner: 'BOT',
          tradeOrigin: 'BOT',
          lastStrategy: 'AEGIS_TURBO',
          lastTradeId: 'AEGIS-TURBO-BTCUSDT-1',
        }),
      ),
    ).toEqual({ status: 'OWNED', strategyId: 'AEGIS_TURBO' });
  });

  it('resolves Micro Burst ownership from its canonical trade id', () => {
    expect(
      resolveStrategyOwnership(
        state({
          positionOwner: 'BOT',
          tradeOrigin: 'BOT',
          lastTradeId: 'MICRO-BURST-ETHUSDT-1',
        }),
      ),
    ).toEqual({ status: 'OWNED', strategyId: 'MICRO_BURST' });
  });

  it('migrates legacy AEGIS ownership using Aegis trade provenance', () => {
    expect(
      resolveStrategyOwnership(
        state({
          positionOwner: 'AEGIS',
          lastTradeId: 'AEGIS-TURBO-BTCUSDT-1',
        }),
      ),
    ).toEqual({ status: 'LEGACY_MIGRATABLE', strategyId: 'AEGIS_TURBO' });
  });

  it('migrates verified legacy AEGIS bot state without a prefixed trade id', () => {
    expect(
      resolveStrategyOwnership(
        state({
          positionOwner: 'AEGIS',
          tradeOrigin: 'BOT',
          ownershipStatus: 'VERIFIED',
          lastTradeId: 'trade-1',
        }),
      ),
    ).toEqual({ status: 'LEGACY_MIGRATABLE', strategyId: 'AEGIS_TURBO' });
  });

  it('migrates legacy AEGIS ownership using Momentum trade provenance', () => {
    expect(
      resolveStrategyOwnership(
        state({
          positionOwner: 'AEGIS',
          lastTradeId: 'MOMENTUM-RIDE-BTCUSDT-1',
        }),
      ),
    ).toEqual({ status: 'LEGACY_MIGRATABLE', strategyId: 'MOMENTUM_RIDE' });
  });

  it('fails closed when strategy fields conflict', () => {
    expect(
      resolveStrategyOwnership(
        state({
          positionOwner: 'BOT',
          tradeOrigin: 'BOT',
          lastStrategy: 'AEGIS_TURBO',
          lastTradeId: 'MOMENTUM-RIDE-BTCUSDT-1',
        }),
      ),
    ).toEqual({
      status: 'AMBIGUOUS',
      strategyIds: ['AEGIS_TURBO', 'MOMENTUM_RIDE'],
    });
  });

  it('never adopts external/manual ownership as a strategy', () => {
    expect(
      resolveStrategyOwnership(
        state({
          positionOwner: 'EXTERNAL',
          tradeOrigin: 'MANUAL_EXTERNAL',
          lastStrategy: 'AEGIS_TURBO',
        }),
      ),
    ).toEqual({ status: 'EXTERNAL' });
  });

  it('requires recovery when canonical BOT ownership lacks strategy evidence', () => {
    expect(
      resolveStrategyOwnership(
        state({
          positionOwner: 'BOT',
          tradeOrigin: 'BOT',
        }),
      ),
    ).toEqual({ status: 'UNKNOWN' });
  });
});
