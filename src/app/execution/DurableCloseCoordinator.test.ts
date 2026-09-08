import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import { FsStateStore } from '../../infra/logging/FsStateStore';
import type {
  IdentifiedCloseRequest,
  IdentifiedCloseEvidence,
  TradingExchangePort,
} from '../ports/Exchange';
import { PositionProtectionService } from '../position/PositionProtectionService';
import { DurableStopCoordinator } from './DurableStopCoordinator';
import { DurableCloseCoordinator } from './DurableCloseCoordinator';
import { createMicroBurstTradePolicy } from '../../strategies/micro-burst/domain/MicroBurstTradePolicy';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-close-'));
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'closes.jsonl');
  const scope = { account: 'fixture', environment: 'offline' };
  const store = new FsStateStore('default', 'fixture', dir).forSymbol('ETHUSDT');
  cleanup.push(() => store.flush!());
  store.set({
    mode: 'LONG_RIDE',
    lastSide: 'LONG',
    lastTradeId: 'trade',
    lastOrderId: '42',
    lastStrategy: 'MICRO_BURST_V1',
    positionOwner: 'BOT',
    lastEntryPrice: 100,
    lastEntryQty: 2,
  });
  let received: IdentifiedCloseRequest | undefined;
  let visible = true;
  let flat = false;
  let partial = false;
  let canceled = false;
  const exchange = {
    readFreshActivePosition: vi.fn(async () =>
      flat ? null : { sideMode: 'BOTH' as const, qtyAbs: 2, entryPrice: 100, leverage: 10 },
    ),
    readActivePosition: vi.fn(async () => null),
    sendMarketCloseOnce: vi.fn(async (r: IdentifiedCloseRequest): Promise<void> => {
      expect(fs.readFileSync(file, 'utf8')).toContain('PREPARED');
      received = { ...r };
      flat = true;
      throw new Error('lost ACK');
    }),
    readMarketCloseByClientOrderId: vi.fn(
      async (r: IdentifiedCloseRequest): Promise<IdentifiedCloseEvidence | null> =>
        visible && received?.clientOrderId === r.clientOrderId
          ? {
              clientOrderId: r.clientOrderId,
              orderId: '99',
              status: partial ? 'PARTIALLY_FILLED' : 'FILLED',
              executedQuantity: partial ? 1 : 2,
            }
          : null,
    ),
    listCloseOrdersForSide: vi.fn(async () =>
      canceled
        ? []
        : [
            {
              orderId: '88',
              type: 'STOP_MARKET' as const,
              stopPrice: 90,
              side: 'SELL' as const,
              positionSide: 'BOTH' as const,
              owner: 'BOT' as const,
              closePosition: true,
            },
          ],
    ),
    readCancelTarget: vi.fn(async () => (canceled ? ('CANCELED' as const) : ('NEW' as const))),
    cancelOrderById: vi.fn(async () => {
      expect(flat).toBe(true);
      canceled = true;
    }),
    closeSideMarketSafe: vi.fn(),
  };
  const make = (io = fs, customScope = scope) => {
    let journal!: FileBackedExecutionJournal;
    const coordinator = new DurableCloseCoordinator({
      scope: customScope,
      exchange,
      journal: () => (journal = new FileBackedExecutionJournal(file, io)),
    });
    const stops = new DurableStopCoordinator({
      scope,
      exchange: exchange as unknown as TradingExchangePort,
      journal: () => new FileBackedExecutionJournal(path.join(dir, 'stops.jsonl')),
    });
    const protector = new PositionProtectionService({
      exchange: exchange as unknown as TradingExchangePort,
      stopCoordinator: stops,
      closeCoordinator: coordinator,
      wait: async () => {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      getRegimeConfig: () => undefined,
      getImmediateTriggerBufferPct: () => 0.001,
      logTradeEvent: async () => {},
    });
    const close = async () => {
      await Promise.allSettled([coordinator.close(), stops.close()]);
    };
    cleanup.push(close);
    return {
      coordinator,
      stops,
      protector,
      close,
      journal: () => journal,
      run: () => coordinator.closeManaged('ETHUSDT', store, protector),
    };
  };
  return {
    file,
    store,
    exchange,
    make,
    setFlat: (v: boolean) => {
      flat = v;
    },
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
    },
    partial: () => {
      partial = true;
    },
  };
}

describe('managed Micro durable close with real close/cancel journals', () => {
  it('persists exact V3 accounting identity before terminal close and retains it on restart', async () => {
    const f = fixture();
    const identity = {
      strategyId: 'MICRO_BURST_V1' as const,
      strategyVersion: 'CONTEXTUAL_V3',
      freezeState: 'DRAFT' as const,
      configHash: `sha256:${'a'.repeat(64)}` as const,
      codeCommitSha: 'b'.repeat(40),
    };
    const policy = createMicroBurstTradePolicy(identity, {
      sizingMode: 'MARGIN_FRACTION',
      marginFraction: 0.9,
      mediumLeverage: 20,
      highLeverage: 30,
      maxConsecutiveNetLosses: 3,
      resetMode: 'SIGNED_OPERATOR',
      feeReserveBps: 14,
      stopStressBps: 10,
    });
    f.store.set({
      lastStrategyVersion: 'CONTEXTUAL_V3',
      lastConfigHash: identity.configHash,
      lastCodeCommitSha: identity.codeCommitSha,
      microBurstTradePolicy: policy,
      microBurstEpisodeId: 'episode',
      microBurstEntrySubmittedAtMs: Date.now() - 1000,
      lastEntryAt: Date.now() - 900,
    });
    const first = f.make();
    expect(await first.run()).toBe(true);
    const settlement = f.store.get().microBurstSettlement;
    expect(settlement).toMatchObject({
      tradeId: 'trade',
      episodeId: 'episode',
      entryOrderId: '42',
      closeOrderIds: ['99'],
      quantity: 2,
      openedAtMs: f.store.get().microBurstEntrySubmittedAtMs,
    });
    expect(f.store.get().microBurstPnlUnverified).toBe(true);
    await first.close();
    const second = f.make();
    await second.coordinator.start();
    await second.coordinator.reconcile(() => f.store, second.protector);
    expect(f.store.get().microBurstSettlement).toEqual(settlement);
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'recovers a transient preflight read without changing existing quarantine=%s',
    async (quarantined) => {
      const f = fixture();
      const first = f.make();
      if (quarantined)
        f.store.set({
          microProtectionBlocked: true,
          microBurstPnlUnverified: true,
          microBurstPnlUnverifiedAt: 123,
        });
      const original = { ...f.store.get() };
      f.exchange.readFreshActivePosition.mockRejectedValueOnce(new Error('preflight timeout'));
      expect(await first.run()).toBe(false);
      expect(await first.journal().listOperations()).toEqual([]);
      expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
      expect(f.exchange.readMarketCloseByClientOrderId).not.toHaveBeenCalled();
      expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
      expect(f.store.get()).toEqual(original);
      expect(first.coordinator.blockedReason()).toBeUndefined();
      expect(first.coordinator.blocksPosition('ETHUSDT', 'trade')).toBe(false);
      expect(first.coordinator.blocksPosition('BTCUSDT', 'other-trade')).toBe(false);

      await first.coordinator.reconcile(() => f.store, first.protector);
      expect(await first.journal().listOperations()).toEqual([]);
      // The runtime's close gate permits the real supervisor to observe again.
      expect(await first.protector.superviseMicroStop('ETHUSDT', f.store.get(), f.store)).toEqual({
        status: 'MISSING',
      });
      expect(f.exchange.readActivePosition).toHaveBeenCalledWith('ETHUSDT', 'LONG');
      expect(f.store.get()).toEqual(original);

      f.hide();
      expect(await first.run()).toBe(false);
      expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
      expect(first.coordinator.blockedReason()).toBe('CLOSE_MUTATION_PENDING');
      expect(await first.run()).toBe(false);
      f.show();
      await first.coordinator.reconcile(() => f.store, first.protector);
      expect(f.store.get().mode).toBe('IDLE');
      expect(first.coordinator.blockedReason()).toBeUndefined();
      expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
    },
  );

  it('settles a lost ACK only using exact fill, fresh flat, durable cancel and unverified accounting', async () => {
    const f = fixture();
    const first = f.make();
    expect(await first.run()).toBe(true);
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.cancelOrderById).toHaveBeenCalledTimes(1);
    expect(f.store.get()).toMatchObject({ mode: 'IDLE', microBurstPnlUnverified: true });
    expect(first.coordinator.blockedReason()).toBeUndefined();
    expect(fs.readFileSync(f.file, 'utf8')).toContain('EXACT_MARKET_QUERY_AND_FRESH_FLAT');
    await first.close();
    const restart = f.make();
    await restart.coordinator.start();
    await restart.coordinator.reconcile(() => f.store, restart.protector);
    expect(restart.coordinator.blockedReason()).toBeUndefined();
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.closeSideMarketSafe).not.toHaveBeenCalled();
  });

  it('flat and missing-position reconciliation cannot bypass an unknown close, including restart', async () => {
    const f = fixture();
    f.hide();
    const first = f.make();
    expect(await first.run()).toBe(false);
    expect(await first.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    await first.close();
    const restart = f.make();
    await restart.coordinator.start();
    await restart.coordinator.reconcile(() => f.store, restart.protector);
    expect(restart.coordinator.blockedReason()).toBe('CLOSE_MUTATION_PENDING');
    expect(await restart.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
    f.show();
    await restart.coordinator.reconcile(() => f.store, restart.protector);
    expect(f.store.get().mode).toBe('IDLE');
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
  });

  it.each(['partial', 'residual'] as const)(
    'quarantines %s permanently, without cleanup or resend',
    async (fault) => {
      const f = fixture();
      const first = f.make();
      if (fault === 'partial') f.partial();
      else
        f.exchange.readMarketCloseByClientOrderId.mockImplementation(async (r) => {
          f.setFlat(false);
          return {
            clientOrderId: r.clientOrderId,
            orderId: '99',
            status: 'FILLED',
            executedQuantity: 2,
          };
        });
      expect(await first.run()).toBe(false);
      f.setFlat(true);
      await first.close();
      const restart = f.make();
      await restart.coordinator.start();
      await restart.coordinator.reconcile(() => f.store, restart.protector);
      expect(f.store.get().mode).toBe('LONG_RIDE');
      expect(restart.coordinator.blockedReason()).toBe('CLOSE_MUTATION_PENDING');
      expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
      expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'lastTradeId',
    'lastOrderId',
    'lastSide',
    'lastEntryQty',
    'lastEntryPrice',
    'ownershipStatus',
    'positionOwner',
    'lastEntryAt',
  ] as const)('revalidates %s after PREPARED and never sends recovered PREPARED', async (field) => {
    const f = fixture();
    const first = f.make();
    await first.coordinator.start();
    const original = { ...f.store.get() };
    const append = first.journal().append.bind(first.journal());
    vi.spyOn(first.journal(), 'append').mockImplementation(async (entry) => {
      const result = await append(entry);
      f.store.set({
        [field]:
          field === 'lastEntryQty' || field === 'lastEntryPrice' || field === 'lastEntryAt'
            ? 3
            : 'changed',
      } as any);
      return result;
    });
    expect(await first.run()).toBe(false);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
    await first.close();
    f.store.set({ ...original, [field]: original[field] });
    const restart = f.make();
    await restart.coordinator.start();
    expect(await restart.run()).toBe(false);
    expect(restart.coordinator.blockedReason()).toBe('CLOSE_MUTATION_PENDING');
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
  });

  it('does not send when fresh quantity changes after persistence', async () => {
    const f = fixture();
    const first = f.make();
    f.exchange.readFreshActivePosition
      .mockResolvedValueOnce({ sideMode: 'BOTH', qtyAbs: 2, entryPrice: 100, leverage: 10 })
      .mockResolvedValue({ sideMode: 'BOTH', qtyAbs: 1, entryPrice: 100, leverage: 10 });
    expect(await first.run()).toBe(false);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
    expect(first.coordinator.blockedReason()).toBe('CLOSE_MUTATION_PENDING');
  });

  it('does not reinterpret a stale exit decision as permission to close a newer parent', async () => {
    const f = fixture();
    const first = f.make();
    const expected = { ...f.store.get() };
    f.store.set({ lastTradeId: 'new-parent' });
    expect(
      await first.coordinator.closeManaged('ETHUSDT', f.store, first.protector, expected),
    ).toBe(false);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
    expect(await first.journal().listOperations()).toEqual([]);
  });

  it('a different local parent cannot bypass unknown close on the same symbol, even on a cold coordinator', async () => {
    const f = fixture();
    f.hide();
    const first = f.make();
    expect(await first.run()).toBe(false);
    await first.close();
    f.store.set({ lastTradeId: 'new-parent' });
    const restart = f.make();
    // closeManaged itself must replay before deciding that this symbol has no pending close.
    expect(await restart.run()).toBe(false);
    expect(await restart.protector.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(false);
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(restart.coordinator.blockedReason()).toBe('CLOSE_MUTATION_PENDING');
  });

  it('fresh-read timeout after exact FILLED is not flat and cannot cancel protection', async () => {
    const f = fixture();
    const first = f.make();
    const lookup = f.exchange.readMarketCloseByClientOrderId.getMockImplementation()!;
    f.exchange.readMarketCloseByClientOrderId.mockImplementation(async (r) => {
      f.exchange.readFreshActivePosition.mockRejectedValue(new Error('timeout'));
      return lookup(r);
    });
    expect(await first.run()).toBe(false);
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.store.get()).toMatchObject({ mode: 'LONG_RIDE', microBurstPnlUnverified: true });
    expect(first.coordinator.blockedReason()).toBe('CLOSE_MUTATION_PENDING');
  });

  it('reobserves after operational persistence succeeds but terminal journal persistence fails', async () => {
    const f = fixture();
    const first = f.make();
    await first.coordinator.start();
    const append = first.journal().append.bind(first.journal());
    vi.spyOn(first.journal(), 'append').mockImplementation(async (entry) => {
      if (entry.event === 'CLOSED') throw new Error('terminal interrupted');
      return append(entry);
    });
    expect(await first.run()).toBe(false);
    expect(f.store.get()).toMatchObject({ mode: 'IDLE', microBurstPnlUnverified: true });
    await first.close();
    const restart = f.make();
    await restart.coordinator.start();
    await restart.coordinator.reconcile(() => f.store, restart.protector);
    expect(restart.coordinator.blockedReason()).toBeUndefined();
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
  });

  it('fails closed on real fsync failure before send', async () => {
    const f = fixture();
    let fail = false;
    const io = Object.create(fs) as typeof fs;
    io.fsyncSync = (fd) => {
      if (fail) throw new Error('fsync unavailable');
      fs.fsyncSync(fd);
    };
    const first = f.make(io);
    await first.coordinator.start();
    fail = true;
    expect(await first.run()).toBe(false);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
    expect(first.coordinator.blockedReason()).toContain('CLOSE_RECOVERY_BLOCKED');
    fail = false;
    expect(await first.run()).toBe(false);
    await first.coordinator.reconcile(() => f.store, first.protector);
    expect(first.coordinator.blocksPosition('BTCUSDT', 'other-trade')).toBe(true);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
    await first.close();
    const restart = f.make();
    await restart.coordinator.start();
    expect(await restart.run()).toBe(false);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
    expect(restart.coordinator.blockedReason()).toBe('CLOSE_MUTATION_PENDING');
  });

  it('excludes synchronously and drains an in-flight send before releasing the writer', async () => {
    const f = fixture();
    const first = f.make();
    await first.coordinator.start();
    let release!: () => void;
    let sent!: () => void;
    const started = new Promise<void>((resolve) => {
      sent = resolve;
    });
    f.exchange.sendMarketCloseOnce.mockImplementation(async () => {
      sent();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const run = first.run();
    expect(first.coordinator.blockedReason()).toBe('CLOSE_MUTATION_PENDING');
    expect(await first.run()).toBe(false);
    await started;
    let closed = false;
    const drain = first.coordinator.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => new FileBackedExecutionJournal(f.file)).toThrow('JOURNAL_WRITER_LOCKED');
    release();
    await run;
    await drain;
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
  });

  it('preserves combined flush and close failures', async () => {
    const f = fixture();
    const first = f.make();
    await first.coordinator.start();
    const flushError = new Error('flush');
    const closeError = new Error('close');
    vi.spyOn(first.journal(), 'flush').mockRejectedValue(flushError);
    const close = first.journal().close.bind(first.journal());
    vi.spyOn(first.journal(), 'close').mockImplementation(async () => {
      await close();
      throw closeError;
    });
    await expect(first.coordinator.close()).rejects.toMatchObject({
      failures: [flushError, closeError],
    });
  });

  it('rejects a different scope even for a terminal close', async () => {
    const f = fixture();
    const first = f.make();
    expect(await first.run()).toBe(true);
    await first.close();
    const restart = f.make(fs, { account: 'other', environment: 'offline' });
    await expect(restart.coordinator.start()).rejects.toThrow('CLOSE_JOURNAL_IDENTITY_INVALID');
  });
});
