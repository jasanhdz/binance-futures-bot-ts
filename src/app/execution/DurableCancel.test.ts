import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import type { BotState } from '../../core/types';
import type { TradingExchangePort } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';
import { PositionProtectionService } from '../position/PositionProtectionService';
import { TradingService } from '../services/TradingService';
import { DurableStopCoordinator } from './DurableStopCoordinator';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-cancel-'));
  const file = path.join(directory, 'mutations.jsonl');
  const scope = { account: 'fixture', environment: 'testnet' };
  let diskFailed = false;
  let journal = new FileBackedExecutionJournal(file, {
    ...fs,
    fsyncSync: (fd) => {
      if (diskFailed) throw new Error('injected fsync failure');
      fs.fsyncSync(fd);
    },
  });
  let state = {
    mode: 'LONG_RIDE',
    positionOwner: 'BOT',
    lastTradeId: 'trade-1',
    lastOrderId: 'entry-1',
    lastSide: 'LONG',
    lastStrategy: 'MICRO_BURST_V1',
    lastEntryAt: 1,
  } as BotState;
  const store: StateStore = {
    get: () => state,
    set: (patch) => (state = { ...state, ...patch }),
    reset: () => {
      throw new Error('no reset');
    },
    flush: vi.fn(async () => undefined),
  };
  let status: 'NEW' | 'CANCELED' | 'FILLED' | null = 'NEW';
  let listed = true;
  const target = {
    orderId: 'ALGO_123',
    type: 'STOP_MARKET' as const,
    stopPrice: 90,
    side: 'SELL' as const,
    positionSide: 'BOTH' as const,
    closePosition: true,
    owner: 'BOT' as const,
  };
  const exchange = {
    readActivePosition: vi.fn(async () => null),
    readFreshActivePosition: vi.fn(async () => null),
    readCancelTarget: vi.fn(async () => status),
    listCloseOrdersForSide: vi.fn(async () => (listed ? [target] : [])),
    cancelOrderById: vi.fn(async () => {
      status = 'CANCELED';
      listed = false;
    }),
    closeSideMarketSafe: vi.fn(async () => undefined),
  };
  const coordinators: DurableStopCoordinator[] = [];
  const compose = () => {
    const coordinator = new DurableStopCoordinator({
      scope,
      journal: () => journal,
      exchange: exchange as unknown as TradingExchangePort,
      wait: async () => undefined,
    });
    coordinators.push(coordinator);
    const protector = new PositionProtectionService({
      exchange: exchange as unknown as TradingExchangePort,
      stopCoordinator: coordinator,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getRegimeConfig: () => undefined,
      getImmediateTriggerBufferPct: () => 0.001,
      logTradeEvent: vi.fn(async () => undefined),
      wait: async () => undefined,
    });
    return { coordinator, protector };
  };
  cleanups.push(async () => {
    for (const coordinator of coordinators) await coordinator.close().catch(() => undefined);
    await journal.close().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...compose(),
    file,
    exchange,
    store,
    target,
    journal,
    failDisk: () => {
      diskFailed = true;
    },
    setStatus: (value: typeof status) => {
      status = value;
    },
    unlist: () => {
      listed = false;
    },
    restart: async (afterStorageFailure = false) => {
      try {
        await coordinators[coordinators.length - 1].close();
      } catch (error) {
        if (!afterStorageFailure) throw error;
      }
      journal = new FileBackedExecutionJournal(file);
      return compose();
    },
  };
}

describe('durable Micro cancellation through the real protector', () => {
  it('blocks admission synchronously while cancel preconditions are being read', async () => {
    const f = fixture();
    const task = f.coordinator.cancelProtection(
      {
        symbol: 'ETHUSDT',
        side: 'LONG',
        orderId: f.target.orderId,
        positionSide: 'BOTH',
        type: 'STOP_MARKET',
        stopPrice: 90,
        parentTradeId: 'trade-1',
        parentOrderId: 'entry-1',
        strategyId: 'MICRO_BURST_V1',
      },
      () => true,
    );
    expect(f.coordinator.cancelBlockedReason()).toBe('CANCEL_MUTATION_PENDING');
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(await task).toBe(true);
    expect(f.coordinator.cancelBlockedReason()).toBeUndefined();
    const entry = await f.journal.readLatest((await f.journal.listOperations())[0]);
    expect(entry?.metadata?.confirmation).toMatchObject({
      status: 'CANCELED',
      source: 'EXACT_TARGET_QUERY',
    });
  });

  it('persists the cleanup quarantine before any target query and does not clear it on unknown evidence', async () => {
    const f = fixture();
    const flush = vi.mocked(f.store.flush!);
    f.exchange.readCancelTarget.mockImplementationOnce(async () => {
      expect(flush).toHaveBeenCalled();
      expect(f.store.get().microProtectionBlocked).toBe(true);
      return null;
    });
    expect(await f.protector.cleanupMicroCloseOrders('ETHUSDT', f.store, f.store.get())).toBe(
      false,
    );
    expect(f.store.get().microProtectionBlocked).toBe(true);
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
  });

  it('rolls back only its own final projection if flush fails and never resends the durable cancellation', async () => {
    const f = fixture();
    vi.mocked(f.store.flush!).mockImplementation(async () => {
      if (f.store.get().mode === 'IDLE') throw new Error('final flush failed');
    });
    await expect(f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).rejects.toThrow(
      'final flush failed',
    );
    expect(f.store.get()).toMatchObject({
      mode: 'LONG_RIDE',
      lastTradeId: 'trade-1',
      microProtectionBlocked: true,
    });
    const latest = await f.journal.readLatest((await f.journal.listOperations())[0]);
    expect(latest?.event).toBe('CLOSED');
    vi.mocked(f.store.flush!).mockResolvedValue(undefined);
    expect(await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(true);
    expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
    expect(f.store.get().microBurstPnlUnverified).toBe(true);
  });

  it.each([false, true])(
    'does not overwrite a new position during final projection flush, rejects=%s',
    async (rejects) => {
      const f = fixture();
      vi.mocked(f.store.flush!).mockImplementation(async () => {
        if (f.store.get().mode !== 'IDLE') return;
        f.store.set({
          lastTradeId: 'T2',
          lastOrderId: 'entry-2',
          lastSide: 'SHORT',
          mode: 'SHORT_RIDE',
          bracketsAttached: true,
          lastExitAt: 456,
          microBurstPnlUnverifiedAt: 789,
        });
        if (rejects) throw new Error('flush changed writer');
      });
      const close = f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store);
      if (rejects) await expect(close).rejects.toThrow('flush changed writer');
      else expect(await close).toBe(false);
      expect(f.store.get()).toMatchObject({
        lastTradeId: 'T2',
        lastOrderId: 'entry-2',
        lastSide: 'SHORT',
        mode: 'SHORT_RIDE',
        bracketsAttached: true,
        lastExitAt: 456,
        microBurstPnlUnverifiedAt: 789,
        microProtectionBlocked: true,
      });
    },
  );

  it('does not erase pre-existing accounting quarantine during operational close', async () => {
    const f = fixture();
    f.store.set({ microBurstPnlUnverified: true, microBurstPnlUnverifiedAt: 123 });
    const state = { ...f.store.get() };
    expect(await f.protector.cleanupMicroCloseOrders('ETHUSDT', f.store, state)).toBe(true);
    expect(
      await f.protector.persistMicroOperationalClose(f.store, state, {
        lastExitAt: Date.now(),
        lastExitReason: 'closed',
        microBurstPnlUnverified: false,
      }),
    ).toBe(true);
    expect(f.store.get()).toMatchObject({
      mode: 'IDLE',
      microBurstPnlUnverified: true,
      microBurstPnlUnverifiedAt: 123,
    });
  });

  it('recovers cancellation after response receipt and a real fsync failure, without another send', async () => {
    const f = fixture();
    f.exchange.cancelOrderById.mockImplementation(async () => {
      f.setStatus('CANCELED');
      f.unlist();
      f.failDisk();
    });
    expect(await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
    expect(f.coordinator.blockedReason()).toContain('CANCEL_MUTATION_BLOCKED');
    expect(f.store.get().mode).toBe('LONG_RIDE');
    const restarted = await f.restart(true);
    await restarted.coordinator.start();
    expect(restarted.coordinator.blockedReason()).toBeUndefined();
    expect(await restarted.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(true);
    expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
  });

  it('rejects a corrupted terminal cancellation proof at startup', async () => {
    const f = fixture();
    expect(await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(true);
    await f.coordinator.close();
    const history = fs
      .readFileSync(f.file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    delete history[history.length - 1].metadata.confirmation;
    const corrupt = history.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    fs.writeFileSync(f.file, corrupt);
    const restarted = await f.restart();
    await expect(restarted.coordinator.start()).rejects.toThrow('CANCEL_CONFIRMATION_INVALID');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(corrupt);
    expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
  });
  it.each(['normal', 'missing', 'emergency'] as const)(
    'journals before %s cleanup and verifies lost ACK by exact lookup',
    async (route) => {
      const f = fixture();
      f.exchange.cancelOrderById.mockImplementation(async () => {
        const ids = await f.journal.listOperations();
        expect(ids).toHaveLength(1);
        expect(await f.journal.readLatest(ids[0])).toMatchObject({
          event: 'PREPARED',
          orderId: 'ALGO_123',
          metadata: { journalOperationMeaning: 'CANCEL_MUTATION_NOT_TRADE' },
        });
        f.setStatus('CANCELED');
        f.unlist();
        throw new Error('lost response');
      });
      if (route === 'normal') {
        expect(await f.protector.cleanupMicroCloseOrders('ETHUSDT', f.store, f.store.get())).toBe(
          true,
        );
        expect(f.store.get().mode).toBe('LONG_RIDE');
      } else if (route === 'missing') {
        expect(await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(true);
        expect(f.store.get().microBurstPnlUnverified).toBe(true);
      } else {
        const service = Object.create(TradingService.prototype) as any;
        service.positionProtection = f.protector;
        vi.spyOn(f.protector, 'superviseMicroStop').mockResolvedValue({
          status: 'RECOVERY_REQUIRED',
          reason: 'fixture emergency',
        });
        service.strategyIdentityForState = () => ({ strategyId: 'MICRO_BURST_V1' });
        service.strategyRuntimeCoordinator = { readMicroBurstExitMarket: vi.fn() };
        service.notifyError = vi.fn();
        service.deps = { exchange: f.exchange, logger: { warn: vi.fn(), error: vi.fn() } };
        f.exchange.readActivePosition.mockResolvedValueOnce({ sideMode: 'BOTH', qtyAbs: 2 } as any);
        await service.managePositionByOwner('ETHUSDT', f.store.get(), f.store);
        expect(f.exchange.closeSideMarketSafe).toHaveBeenCalledTimes(1);
        expect(f.store.get().mode).toBe('IDLE');
      }
      expect(f.exchange.cancelOrderById).toHaveBeenCalledExactlyOnceWith('ETHUSDT', 'ALGO_123');
      const history = await f.journal.read((await f.journal.listOperations())[0]);
      expect(history.map((entry) => entry.event)).toEqual([
        'PREPARED',
        'UNKNOWN',
        'CLOSE_PENDING',
        'CLOSED',
      ]);
      expect(history.every((entry) => entry.clientOrderId === undefined)).toBe(true);
      const restarted = await f.restart();
      await restarted.coordinator.start();
      expect(restarted.coordinator.blockedReason()).toBeUndefined();
      expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, 'NEW', 'FILLED'] as const)(
    'retains %s even when unlisted, and never resends across restart',
    async (status) => {
      const f = fixture();
      f.exchange.cancelOrderById.mockImplementation(async () => {
        f.setStatus(status);
        f.unlist();
        throw new Error('lost');
      });
      expect(await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
      expect(f.coordinator.blockedReason()).toBe('CANCEL_MUTATION_PENDING');
      expect(await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
      const restarted = await f.restart();
      await restarted.coordinator.start();
      expect(restarted.coordinator.blockedReason()).toBe('CANCEL_MUTATION_PENDING');
      expect(await restarted.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(
        false,
      );
      expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
      f.setStatus('CANCELED');
      await restarted.coordinator.reconcileClosed(() => f.store);
      expect(restarted.coordinator.blockedReason()).toBeUndefined();
      expect(f.store.get().mode).toBe('LONG_RIDE');
      expect(await restarted.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(
        true,
      );
    },
  );

  it('rejects surviving BOT orders despite terminal lookup', async () => {
    const f = fixture();
    f.exchange.cancelOrderById.mockImplementation(async () => {
      f.setStatus('CANCELED');
    });
    await expect(f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).rejects.toThrow(
      'MICRO_BOT_CLOSE_ORDERS_REMAIN',
    );
    expect(f.store.get().mode).toBe('LONG_RIDE');
  });

  it('does not resend an UNKNOWN cancellation while its target still appears in the list', async () => {
    const f = fixture();
    f.exchange.cancelOrderById.mockRejectedValue(new Error('lost response'));
    expect(await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
    expect(await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
    const restarted = await f.restart();
    await restarted.coordinator.start();
    expect(await restarted.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
    expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
    expect(f.store.get().mode).toBe('LONG_RIDE');
  });

  it('leaves manual close orders untouched while finalizing only the local operational close', async () => {
    const f = fixture();
    f.exchange.listCloseOrdersForSide.mockResolvedValue([{ ...f.target, owner: 'UNKNOWN' } as any]);
    expect(await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(true);
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.exchange.readCancelTarget).not.toHaveBeenCalled();
    expect(await f.journal.listOperations()).toEqual([]);
    expect(f.store.get().microBurstPnlUnverified).toBe(true);
  });

  it('keeps emergency close state unresolved after a lost cancellation with no exact evidence', async () => {
    const f = fixture();
    const service = Object.create(TradingService.prototype) as any;
    service.positionProtection = f.protector;
    vi.spyOn(f.protector, 'superviseMicroStop').mockResolvedValue({
      status: 'RECOVERY_REQUIRED',
      reason: 'fixture emergency',
    });
    service.strategyIdentityForState = () => ({ strategyId: 'MICRO_BURST_V1' });
    service.strategyRuntimeCoordinator = { readMicroBurstExitMarket: vi.fn() };
    service.notifyError = vi.fn();
    service.deps = { exchange: f.exchange, logger: { warn: vi.fn(), error: vi.fn() } };
    f.exchange.readActivePosition.mockResolvedValueOnce({ sideMode: 'BOTH', qtyAbs: 2 } as any);
    f.exchange.cancelOrderById.mockImplementation(async () => {
      f.setStatus(null);
      f.unlist();
      throw new Error('lost');
    });
    await service.managePositionByOwner('ETHUSDT', f.store.get(), f.store);
    expect(f.store.get().mode).toBe('LONG_RIDE');
    expect(f.coordinator.blockedReason()).toBe('CANCEL_MUTATION_PENDING');
    const restarted = await f.restart();
    await restarted.coordinator.start();
    expect(await restarted.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
    expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
  });

  it('collects flush and close failures without abandoning the journal close', async () => {
    const f = fixture();
    await f.coordinator.start();
    const flushError = new Error('flush failed');
    const closeError = new Error('close failed');
    vi.spyOn(f.journal, 'flush').mockRejectedValue(flushError);
    const close = f.journal.close.bind(f.journal);
    vi.spyOn(f.journal, 'close').mockImplementation(async () => {
      await close();
      throw closeError;
    });
    await expect(f.coordinator.close()).rejects.toMatchObject({
      failures: [flushError, closeError],
    });
    expect(f.journal.close).toHaveBeenCalledTimes(1);
    await expect(f.coordinator.close()).rejects.toMatchObject({
      failures: [flushError, closeError],
    });
  });

  it.each([
    'state disk',
    'journal disk',
    'new trade flush',
    'new trade prepared',
    'manual',
    'manual lookup',
    'not flat',
  ] as const)('does not send on %s', async (fault) => {
    const f = fixture();
    if (fault === 'state disk') vi.mocked(f.store.flush!).mockRejectedValue(new Error('disk full'));
    if (fault === 'journal disk') f.failDisk();
    if (fault === 'new trade flush')
      vi.mocked(f.store.flush!).mockImplementation(async () => {
        f.store.set({ lastTradeId: 'new' });
      });
    if (fault === 'new trade prepared') {
      const append = f.journal.append.bind(f.journal);
      vi.spyOn(f.journal, 'append').mockImplementation(async (input) => {
        const entry = await append(input);
        f.store.set({ lastTradeId: 'new' });
        return entry;
      });
    }
    if (fault === 'manual') f.store.set({ positionOwner: 'UNKNOWN' as any });
    if (fault === 'manual lookup') f.setStatus(null);
    if (fault === 'not flat')
      f.exchange.readFreshActivePosition.mockResolvedValue({ qtyAbs: 2 } as any);
    await f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store).catch(() => false);
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.store.get().mode).toBe('LONG_RIDE');
    if (fault === 'new trade prepared') {
      const restarted = await f.restart();
      await restarted.coordinator.start();
      expect(restarted.coordinator.blockedReason()).toBe('CANCEL_MUTATION_PENDING');
      expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    }
  });

  it('drains pending transport before releasing the journal writer', async () => {
    const f = fixture();
    let release!: () => void;
    let sent!: () => void;
    const started = new Promise<void>((resolve) => {
      sent = resolve;
    });
    f.exchange.cancelOrderById.mockImplementation(async () => {
      sent();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const task = f.protector.reconcileMissingMicroPosition('ETHUSDT', f.store);
    await started;
    let closed = false;
    const close = f.coordinator.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await task;
    await close;
    const restarted = await f.restart();
    await restarted.coordinator.start();
    expect(restarted.coordinator.blockedReason()).toBe('CANCEL_MUTATION_PENDING');
    expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
  });
});
