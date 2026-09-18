import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import { FsStateStore } from '../../infra/logging/FsStateStore';
import { DurableCloseCoordinator } from '../execution/DurableCloseCoordinator';
import { DurableStopCoordinator } from '../execution/DurableStopCoordinator';
import type {
  IdentifiedCloseRequest,
  IdentifiedStopRequest,
  TradingExchangePort,
} from '../ports/Exchange';
import { PositionProtectionService } from './PositionProtectionService';
import { TradingService } from '../services/TradingService';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-uncertainty-'));
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  let store = new FsStateStore('default', 'test', dir).forSymbol('ADAUSDT');
  cleanup.push(() => store.flush());
  store.set({
    mode: 'SHORT_RIDE',
    lastSide: 'SHORT',
    lastTradeId: 'trade',
    lastOrderId: '42',
    lastStrategy: 'MICRO_BURST',
    positionOwner: 'BOT',
    lastEntryQty: 2,
    lastEntryPrice: 100,
    lastStopPrice: 110,
    lastEntryAt: 1000,
    microBurstEntrySubmittedAtMs: 900,
  });
  let now = 2000;
  let flat = false;
  let stopVisible = false;
  let closeVisible = true;
  let stopRequest: IdentifiedStopRequest | undefined;
  let closeRequest: IdentifiedCloseRequest | undefined;
  const position = { sideMode: 'BOTH' as const, qtyAbs: 2, entryPrice: 100, leverage: 10 };
  const exchange = {
    readActivePosition: vi.fn(async () => (flat ? null : { ...position })),
    readFreshActivePosition: vi.fn(async () => (flat ? null : { ...position })),
    listCloseOrdersForSide: vi.fn(async () => []),
    getMarkPrice: vi.fn(async () => 100),
    getSymbolFilters: vi.fn(async () => ({ tickSize: 0.01, pricePrecision: 2 })),
    sendStopCloseOnce: vi.fn(async (r: IdentifiedStopRequest) => {
      stopRequest = { ...r };
      throw new Error('lost stop ACK');
    }),
    readStopCloseByClientOrderId: vi.fn(async (r: IdentifiedStopRequest) =>
      stopVisible && stopRequest?.clientOrderId === r.clientOrderId
        ? { clientOrderId: r.clientOrderId, orderId: '88' }
        : null,
    ),
    readStopCloseState: vi.fn(async () => null),
    sendMarketCloseOnce: vi.fn(async (r: IdentifiedCloseRequest) => {
      closeRequest = { ...r };
      flat = true;
      throw new Error('lost close ACK');
    }),
    readMarketCloseByClientOrderId: vi.fn(async (r: IdentifiedCloseRequest) =>
      closeVisible && closeRequest?.clientOrderId === r.clientOrderId
        ? {
            clientOrderId: r.clientOrderId,
            orderId: '99',
            status: 'FILLED' as const,
            executedQuantity: 2,
          }
        : null,
    ),
    placeStopClose: vi.fn(),
    closeSideMarketSafe: vi.fn(),
    cancelOrderById: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const make = () => {
    const scope = { account: 'fixture', environment: 'offline' };
    const stops = new DurableStopCoordinator({
      scope,
      exchange: exchange as unknown as TradingExchangePort,
      journal: () => new FileBackedExecutionJournal(path.join(dir, 'stops.jsonl')),
    });
    const closes = new DurableCloseCoordinator({
      scope,
      exchange,
      journal: () => new FileBackedExecutionJournal(path.join(dir, 'closes.jsonl')),
    });
    const protection = new PositionProtectionService({
      stopCoordinator: stops,
      closeCoordinator: closes,
      exchange: exchange as unknown as TradingExchangePort,
      logger,
      now: () => now,
      wait: async () => {},
      getRegimeConfig: () => undefined,
      getImmediateTriggerBufferPct: () => 0.001,
      logTradeEvent: async () => {},
    });
    const shutdown = () => Promise.all([stops.close(), closes.close()]);
    cleanup.push(shutdown);
    const service = Object.create(TradingService.prototype) as any;
    service.strategyIdentityForState = () => ({ strategyId: 'MICRO_BURST' });
    service.positionProtection = protection;
    service.stateForSymbol = () => store;
    service.deps = { closeCoordinator: closes, logger, exchange };
    service.notifyError = vi.fn(async () => {});
    service.positionManagerRouter = { route: vi.fn() };
    return {
      stops,
      closes,
      protection,
      shutdown,
      run: () => protection.superviseMicroStop('ADAUSDT', store.get(), store),
      close: () => closes.closeManaged('ADAUSDT', store, protection),
      manage: async () => {
        await closes.start();
        await service.managePositionByOwner('ADAUSDT', store.get(), store);
      },
      route: service.positionManagerRouter.route,
    };
  };
  return {
    exchange,
    logger,
    make,
    store: () => store,
    setNow: (v: number) => {
      now = v;
    },
    showStop: () => {
      stopVisible = true;
    },
    hideClose: () => {
      closeVisible = false;
    },
    showClose: () => {
      closeVisible = true;
    },
    reload: () => {
      store = new FsStateStore('default', 'test', dir).forSymbol('ADAUSDT');
    },
  };
}

describe('bounded durable Micro stop uncertainty', () => {
  it('routes timeout through TradingService durable recovery, never through strategic or legacy close', async () => {
    const f = fixture();
    const runtime = f.make();
    await runtime.manage();
    expect(runtime.route).not.toHaveBeenCalled();
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
    f.setNow(32000);
    await runtime.manage();
    expect(f.store().get().mode).toBe('IDLE');
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(runtime.route).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer trade from the management continuation', async () => {
    const f = fixture();
    const runtime = f.make();
    await runtime.manage();
    f.setNow(32000);
    f.exchange.readFreshActivePosition.mockImplementation(async () => {
      f.store().set({
        lastTradeId: 'new-trade',
        lastOrderId: '43',
        microProtectionBlocked: false,
        bracketsAttached: true,
        microStopUncertainty: undefined,
      });
      return { sideMode: 'BOTH', qtyAbs: 2, entryPrice: 100, leverage: 10 };
    });
    await runtime.manage();
    expect(f.store().get()).toMatchObject({
      lastTradeId: 'new-trade',
      lastOrderId: '43',
      microProtectionBlocked: false,
      bracketsAttached: true,
    });
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
  });
  it('accepts exact current stop evidence despite a lost ACK without starting recovery', async () => {
    const f = fixture();
    f.showStop();
    const runtime = f.make();
    expect((await runtime.run()).status).toBe('PROTECTED');
    expect(f.store().get().microStopUncertainty).toBeUndefined();
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
  });
  it('reconciles a lost ACK using the same stop identity, including late confirmation after restart', async () => {
    const f = fixture();
    const first = f.make();
    expect((await first.run()).status).toBe('UNKNOWN');
    const pending = { ...f.store().get().microStopUncertainty! };
    expect(pending).toMatchObject({ startedAt: 2000, deadlineAt: 32000, recoveryRequested: false });
    await first.shutdown();
    f.reload();
    const second = f.make();
    f.setNow(40000);
    f.showStop();
    expect((await second.run()).status).toBe('PROTECTED');
    expect(f.store().get().microStopUncertainty).toBeUndefined();
    expect(f.store().get()).toMatchObject({ lastEntryAt: 1000, microBurstEntrySubmittedAtMs: 900 });
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
    expect(
      f.exchange.readStopCloseByClientOrderId.mock.calls.every(
        ([r]) => r.clientOrderId === pending.clientOrderId,
      ),
    ).toBe(true);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
    expect(f.logger.info).toHaveBeenCalledWith(
      'micro_stop_uncertainty_resolved',
      expect.objectContaining({ clientOrderId: pending.clientOrderId }),
    );
    f.reload();
    expect(f.store().get().microStopUncertainty).toBeUndefined();
  });

  it('persists one deadline, closes once after timeout, and recovers a lost close ACK after restart', async () => {
    const f = fixture();
    const first = f.make();
    await first.run();
    const pending = { ...f.store().get().microStopUncertainty! };
    f.setNow(31999);
    expect((await first.run()).status).toBe('UNKNOWN');
    expect(f.store().get().microStopUncertainty).toEqual(pending);
    await first.shutdown();
    f.reload();
    const second = f.make();
    f.setNow(32000);
    expect(await second.run()).toEqual({
      status: 'RECOVERY_REQUIRED',
      reason: 'MICRO_STOP_DURABLE_UNCERTAINTY_TIMEOUT',
    });
    expect((await second.run()).status).toBe('RECOVERY_REQUIRED');
    expect(
      f.logger.warn.mock.calls.filter(([event]) => event === 'micro_stop_uncertainty_expired'),
    ).toHaveLength(1);
    f.hideClose();
    expect(await second.close()).toBe(false);
    expect(await second.close()).toBe(false);
    await second.shutdown();
    f.reload();
    const third = f.make();
    await third.stops.start();
    f.showClose();
    await third.closes.reconcile(() => f.store(), third.protection);
    expect(f.store().get()).toMatchObject({
      mode: 'IDLE',
      microBurstPnlUnverified: true,
      lastEntryAt: 1000,
      microBurstEntrySubmittedAtMs: 900,
    });
    expect(f.store().get().microStopUncertainty).toBeUndefined();
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.placeStopClose).not.toHaveBeenCalled();
    expect(f.exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    // A never-observed stop cannot be retired from empty listings. Admission stays blocked.
    await third.stops.reconcileClosed(() => f.store());
    expect(third.stops.blockedReason()).toBe('STOP_MUTATION_PENDING');
  });

  it.each([
    'position-read',
    'fresh-read',
    'different-quantity',
    'different-entry',
    'different-side',
    'new-trade',
    'flush',
    'clock',
    'deadline',
    'stop-identity',
    'journal-identity',
  ])('does not authorize recovery under %s and does not reset the deadline', async (failure) => {
    const f = fixture();
    const runtime = f.make();
    await runtime.run();
    const pending = { ...f.store().get().microStopUncertainty! };
    f.setNow(40000);
    if (failure === 'position-read')
      f.exchange.readActivePosition.mockRejectedValue(new Error('read failed'));
    if (failure === 'fresh-read')
      f.exchange.readFreshActivePosition.mockRejectedValue(new Error('read failed'));
    if (failure === 'different-quantity')
      f.exchange.readFreshActivePosition.mockResolvedValue({
        sideMode: 'BOTH',
        qtyAbs: 3,
        entryPrice: 100,
        leverage: 10,
      });
    if (failure === 'different-entry')
      f.exchange.readFreshActivePosition.mockResolvedValue({
        sideMode: 'BOTH',
        qtyAbs: 2,
        entryPrice: 101,
        leverage: 10,
      });
    if (failure === 'different-side')
      f.exchange.readFreshActivePosition.mockResolvedValue({
        sideMode: 'LONG' as any,
        qtyAbs: 2,
        entryPrice: 100,
        leverage: 10,
      });
    if (failure === 'new-trade')
      f.exchange.readFreshActivePosition.mockImplementation(async () => {
        f.store().set({ lastTradeId: 'new-trade', microStopUncertainty: undefined });
        return { sideMode: 'BOTH', qtyAbs: 2, entryPrice: 100, leverage: 10 };
      });
    if (failure === 'flush')
      vi.spyOn(f.store(), 'flush').mockRejectedValueOnce(new Error('disk failed'));
    if (failure === 'clock') f.setNow(1999);
    if (failure === 'deadline')
      f.store().set({ microStopUncertainty: { ...pending, deadlineAt: NaN } });
    if (failure === 'stop-identity')
      f.store().set({
        microStopUncertainty: { ...pending, clientOrderId: `bot_sl_${'f'.repeat(28)}` },
      });
    if (failure === 'journal-identity') f.store().set({ lastOrderId: '43' });
    expect((await runtime.run()).status).toBe('UNKNOWN');
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
    if (failure === 'new-trade') {
      expect(f.store().get().lastTradeId).toBe('new-trade');
      expect(f.store().get().microStopUncertainty).toBeUndefined();
    } else expect(f.store().get().microStopUncertainty?.startedAt).toBe(pending.startedAt);
  });

  it('allows timeout recovery after exact stop query failure, but only with a verified position', async () => {
    const f = fixture();
    const runtime = f.make();
    await runtime.run();
    f.setNow(32000);
    f.exchange.readStopCloseByClientOrderId.mockRejectedValue(new Error('query unavailable'));
    expect((await runtime.run()).status).toBe('RECOVERY_REQUIRED');
    expect(await runtime.close()).toBe(true);
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
  });
});
