import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TradingExchangePort } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';
import { composeDurableEntryCoordinator } from './DurableEntryComposition';
import type { BotState } from '../../core/types';
import type { StrategyExecutionIntent } from '../../core/strategy/StrategyExecution';

describe('production durable entry factory in an explicit filesystem fixture', () => {
  it.each([
    'absent',
    'read-error',
    'foreign',
    'partial',
    'wrong-side',
    'valid',
    'identity-changed',
    'missing-tp',
  ])('checks actual protection before releasing durable handoff: %s', async (scenario) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-handoff-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    let current: BotState = {
      mode: 'LONG_RIDE',
      lastTradeId: 'T1',
      lastOrderId: 'O1',
      lastSide: 'LONG',
      lastStrategy: 'MICRO_BURST',
      bracketsAttached: true,
    };
    const store: StateStore = {
      get: () => ({ ...current }),
      set: (patch) => (current = { ...current, ...patch }),
      reset: () => {
        current = { mode: 'IDLE' };
      },
      flush: vi.fn(async () => {}),
    };
    type Orders = Awaited<ReturnType<TradingExchangePort['listCloseOrdersForSide']>>;
    const stop: Orders[number] = {
      orderId: 'S1',
      type: 'STOP_MARKET',
      stopPrice: 90,
      owner: 'BOT',
      side: 'SELL',
      positionSide: 'BOTH',
      closePosition: true,
    };
    const list = vi.fn(async (): Promise<Orders> => {
      if (scenario === 'read-error') throw new Error('timeout');
      if (scenario === 'identity-changed') current.lastTradeId = 'T2';
      if (scenario === 'absent') return [];
      return [
        {
          ...stop,
          ...(scenario === 'foreign' ? { owner: 'UNKNOWN' as const } : {}),
          ...(scenario === 'partial'
            ? { closePosition: false, reduceOnly: true, quantity: 0.5 }
            : {}),
          ...(scenario === 'wrong-side' ? { side: 'BUY' as const } : {}),
        },
      ];
    });
    const exchange = {
      readMarketOpenByClientOrderId: vi.fn(async () => ({ orderId: 'O1', avgPrice: 100 })),
      readActivePosition: vi.fn(async () => ({
        sideMode: 'BOTH',
        qtyAbs: 1,
        entryPrice: 100,
        leverage: 10,
      })),
      listCloseOrdersForSide: list,
    } as unknown as TradingExchangePort;
    const coordinator = composeDurableEntryCoordinator(exchange, true, store);
    const intent: StrategyExecutionIntent = {
      identity: {
        strategyId: 'MICRO_BURST',
        strategyVersion: 'v1',
        freezeState: 'DRAFT',
        codeCommitSha: 'fixture',
      },
      tradeId: 'T1',
      symbol: 'ETHUSDT',
      side: 'LONG',
      requestedAt: 1000,
      leverage: 10,
      positionFraction: 0.1,
      structuralStopPrice: 90,
      protection: {
        requireStop: true,
        requireTakeProfit: scenario === 'missing-tp',
        closeIfProtectionFails: true,
      },
      metadata: {},
    };
    try {
      await coordinator.start();
      const send = vi.fn(async () => ({ orderId: 'O1', avgPrice: 100 }));
      expect((await coordinator.execute(intent, 1, 'se_fixture', send)).status).toBe('CONFIRMED');
      expect(coordinator.blockedReason()).toBe(
        scenario === 'valid' ? undefined : 'ENTRY_MUTATION_PENDING',
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
      if (scenario === 'identity-changed') expect(current.lastTradeId).toBe('T2');
      if (scenario !== 'valid') expect(store.flush).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
      cwd.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it('creates the scoped writer only at startup, rejects a competitor, and retains orphan locks', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-composition-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const exchange = {
      readMarketOpenByClientOrderId: vi.fn().mockResolvedValue(null),
    } as unknown as TradingExchangePort;
    const state: StateStore = {
      get: () => ({ mode: 'IDLE' }),
      set: () => ({ mode: 'IDLE' }),
      reset: () => {},
      flush: async () => {},
    };
    const first = composeDurableEntryCoordinator(exchange, true, state);
    const competitor = composeDurableEntryCoordinator(exchange, true, state);
    const production = composeDurableEntryCoordinator(exchange, false, state);
    try {
      expect(fs.readdirSync(directory)).toEqual([]);
      await first.start();
      expect(fs.readdirSync(path.join(directory, 'data/runtime'))).toEqual([
        'entry-mutations-binance-futures-bot-primary-testnet.jsonl',
        'entry-mutations-binance-futures-bot-primary-testnet.jsonl.lock',
      ]);
      await expect(competitor.start()).rejects.toThrow('JOURNAL_WRITER_LOCKED');
      await production.start();
      expect(exchange.readMarketOpenByClientOrderId).not.toHaveBeenCalled();
      await first.close();
      const lock = path.join(
        directory,
        'data/runtime/entry-mutations-binance-futures-bot-primary-testnet.jsonl.lock',
      );
      fs.writeFileSync(lock, '999999999:orphan\n');
      const orphanAttempt = composeDurableEntryCoordinator(exchange, true, state);
      await expect(orphanAttempt.start()).rejects.toThrow('JOURNAL_WRITER_LOCKED');
      expect(fs.readFileSync(lock, 'utf8')).toBe('999999999:orphan\n');
      await orphanAttempt.close().catch(() => undefined);
    } finally {
      await Promise.allSettled([first.close(), competitor.close(), production.close()]);
      cwd.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
