import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import { FsStateStore } from '../../infra/logging/FsStateStore';
import { PositionProtectionService } from '../position/PositionProtectionService';
import type { TradingExchangePort, IdentifiedStopRequest } from '../ports/Exchange';
import { DurableStopCoordinator } from './DurableStopCoordinator';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-stop-'));
  cleanup.push(async () => fs.rmSync(dir, { force: true, recursive: true }));
  const file = path.join(dir, 'stops.jsonl');
  const scope = { account: 'fixture', environment: 'offline' };
  const store = new FsStateStore('default', 'fixture', dir).forSymbol('ETHUSDT');
  cleanup.push(store.flush.bind(store));
  store.set({
    mode: 'LONG_RIDE',
    lastSide: 'LONG',
    lastTradeId: 'trade',
    lastOrderId: '42',
    lastStrategy: 'MICRO_BURST_V1',
    positionOwner: 'BOT',
    lastEntryPrice: 100,
    lastEntryQty: 2,
    lastStopPrice: 90,
  });
  let received: IdentifiedStopRequest | undefined;
  let visible = true;
  const exchange = {
    readActivePosition: vi.fn(async () => ({
      sideMode: 'BOTH',
      qtyAbs: 2,
      entryPrice: 100,
      leverage: 10,
    })),
    listCloseOrdersForSide: vi
      .fn<TradingExchangePort['listCloseOrdersForSide']>()
      .mockResolvedValue([]),
    readFreshActivePosition: vi
      .fn<NonNullable<TradingExchangePort['readFreshActivePosition']>>()
      .mockResolvedValue(null),
    readStopCloseState: vi
      .fn<NonNullable<TradingExchangePort['readStopCloseState']>>()
      .mockImplementation(async (request) => ({
        clientOrderId: request.clientOrderId,
        orderId: '99',
        status: 'CANCELED',
      })),
    getMarkPrice: vi.fn(async () => 100),
    getSymbolFilters: vi.fn(async () => ({ tickSize: 0.01, pricePrecision: 2 })),
    sendStopCloseOnce: vi.fn(async (request: IdentifiedStopRequest) => {
      expect(fs.readFileSync(file, 'utf8')).toContain('PREPARED');
      received = { ...request };
      return { clientOrderId: request.clientOrderId, orderId: '99' };
    }),
    readStopCloseByClientOrderId: vi.fn(async (request: IdentifiedStopRequest) =>
      visible && received?.clientOrderId === request.clientOrderId
        ? { clientOrderId: received.clientOrderId, orderId: '99' }
        : null,
    ),
    placeStopClose: vi.fn(),
    placeTpClose: vi.fn(),
    cancelOrderById: vi.fn(),
    closeSideMarketSafe: vi.fn(),
  };
  const make = (customScope = scope, io = fs) => {
    const coordinator = new DurableStopCoordinator({
      scope: customScope,
      exchange: exchange as unknown as TradingExchangePort,
      journal: () => new FileBackedExecutionJournal(file, io),
      wait: async () => {},
    });
    cleanup.push(() => coordinator.close().catch(() => undefined));
    const protection = new PositionProtectionService({
      stopCoordinator: coordinator,
      exchange: exchange as unknown as TradingExchangePort,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      getRegimeConfig: () => undefined,
      getImmediateTriggerBufferPct: () => 0.001,
      logTradeEvent: async () => {},
    });
    return { coordinator, run: () => protection.superviseMicroStop('ETHUSDT', store.get(), store) };
  };
  return {
    file,
    scope,
    store,
    exchange,
    make,
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
    },
  };
}

describe('durable Micro stop vertical with real journal and projection', () => {
  async function closedFixture() {
    const f = fixture();
    const first = f.make();
    expect((await first.run()).status).toBe('PROTECTED');
    f.store.set({
      mode: 'IDLE',
      lastExitAt: Date.now(),
      lastExitReason: 'FLAT_CONFIRMED_ACCOUNTING_PENDING',
      microBurstPnlUnverified: true,
      microProtectionBlocked: false,
    });
    await f.store.flush();
    f.exchange.sendStopCloseOnce.mockClear();
    return { ...f, first };
  }

  it('retires a canceled stop only after durable close and fresh flat evidence, preserving accounting across restart', async () => {
    const f = await closedFixture();
    const before = f.store.get();
    const set = vi.spyOn(f.store, 'set');
    await f.first.coordinator.reconcileClosed(() => f.store);
    expect(f.first.coordinator.blockedReason()).toBeUndefined();
    expect(f.exchange.readFreshActivePosition).toHaveBeenCalledTimes(3);
    expect(f.exchange.sendStopCloseOnce).not.toHaveBeenCalled();
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(f.store.get()).toEqual(before);
    const raw = fs.readFileSync(f.file, 'utf8');
    expect(raw).toContain('STOP_RETIREMENT_V1');
    await f.first.coordinator.close();
    const restarted = f.make();
    await restarted.coordinator.start();
    expect(restarted.coordinator.blockedReason()).toBeUndefined();
    await restarted.coordinator.reconcileClosed(() => f.store);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(raw);
    expect(f.store.get().microBurstPnlUnverified).toBe(true);
  });

  it.each([
    'unknown-order',
    'working-stop',
    'different-order',
    'position-reappears',
    'undefined-position',
    'read-error',
    'survivor',
    'list-error',
    'state-changed',
    'state-flush-failed',
    'future-exit',
  ])('retains the block and never mutates exchange under %s', async (failure) => {
    const f = await closedFixture();
    if (failure === 'unknown-order') f.exchange.readStopCloseState.mockResolvedValue(null);
    if (failure === 'working-stop')
      f.exchange.readStopCloseState.mockImplementation(async (request) => ({
        clientOrderId: request.clientOrderId,
        orderId: '99',
        status: 'NEW',
      }));
    if (failure === 'different-order')
      f.exchange.readStopCloseState.mockImplementation(async (request) => ({
        clientOrderId: request.clientOrderId,
        orderId: '100',
        status: 'CANCELED',
      }));
    if (failure === 'position-reappears')
      f.exchange.readFreshActivePosition
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ sideMode: 'BOTH', qtyAbs: 2, entryPrice: 100, leverage: 10 });
    if (failure === 'undefined-position')
      f.exchange.readFreshActivePosition.mockResolvedValueOnce(undefined as unknown as null);
    if (failure === 'read-error')
      f.exchange.readFreshActivePosition.mockRejectedValueOnce(new Error('timeout'));
    if (failure === 'survivor')
      f.exchange.listCloseOrdersForSide.mockResolvedValue([
        { orderId: 'BOT', type: 'STOP_MARKET', stopPrice: 90, owner: 'BOT' },
      ]);
    if (failure === 'list-error')
      f.exchange.listCloseOrdersForSide.mockRejectedValueOnce(new Error('list error'));
    if (failure === 'state-changed')
      f.exchange.readFreshActivePosition.mockImplementationOnce(async () => {
        f.store.set({ lastTradeId: 'T2' });
        return null;
      });
    if (failure === 'state-flush-failed')
      vi.spyOn(f.store, 'flush').mockRejectedValueOnce(new Error('disk'));
    if (failure === 'future-exit') f.store.set({ lastExitAt: Date.now() + 60_000 });
    // Restart reestablishes the conservative pending set, including historical CLOSED stops.
    await f.first.coordinator.close();
    const restarted = f.make();
    await restarted.coordinator.start();
    const raw = fs.readFileSync(f.file, 'utf8');
    await restarted.coordinator.reconcileClosed(() => f.store);
    expect(restarted.coordinator.blockedReason()).toBe('STOP_MUTATION_PENDING');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(raw);
    expect(f.exchange.sendStopCloseOnce).not.toHaveBeenCalled();
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
    expect(f.exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(f.store.get().microBurstPnlUnverified).toBe(true);
    if (failure === 'state-changed') expect(f.store.get().lastTradeId).toBe('T2');
  });

  it('does not retire another trade in the same symbol and keeps manual orders untouched', async () => {
    const f = await closedFixture();
    await f.first.coordinator.close();
    const next = f.make();
    await next.coordinator.start();
    f.store.set({ lastTradeId: 'OTHER' });
    await next.coordinator.reconcileClosed(() => f.store);
    expect(next.coordinator.blockedReason()).toBe('STOP_MUTATION_PENDING');
    expect(f.exchange.readStopCloseState).not.toHaveBeenCalled();
    f.store.set({ lastTradeId: 'trade' });
    f.exchange.listCloseOrdersForSide.mockResolvedValue([
      { orderId: 'MANUAL', type: 'STOP_MARKET', stopPrice: 90, owner: 'UNKNOWN' },
    ]);
    await next.coordinator.reconcileClosed(() => f.store);
    expect(next.coordinator.blockedReason()).toBeUndefined();
    expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
  });

  it('retains uncertainty on retirement fsync failure and recovers the partial protocol idempotently', async () => {
    const f = await closedFixture();
    await f.first.coordinator.close();
    let armed = false;
    const next = f.make(f.scope, {
      ...fs,
      fsyncSync: (fd: number) => {
        fs.fsyncSync(fd);
        if (armed) {
          armed = false;
          throw new Error('retirement disk error after bytes');
        }
      },
    });
    await next.coordinator.start();
    armed = true;
    await next.coordinator.reconcileClosed(() => f.store);
    expect(next.coordinator.blockedReason()).toContain('STOP_RETIREMENT_JOURNAL_BLOCKED');
    await expect(next.coordinator.close()).rejects.toThrow();
    const recovered = f.make();
    await recovered.coordinator.start();
    expect(recovered.coordinator.blockedReason()).toBe('STOP_MUTATION_PENDING');
    await recovered.coordinator.reconcileClosed(() => f.store);
    expect(recovered.coordinator.blockedReason()).toBeUndefined();
    const count = fs
      .readFileSync(f.file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('STOP_RETIREMENT_V1')).length;
    expect(count).toBe(3);
    expect(f.exchange.sendStopCloseOnce).not.toHaveBeenCalled();
  });

  it('keeps the writer until an in-flight retirement observation finishes during shutdown', async () => {
    const f = await closedFixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.exchange.readStopCloseState.mockImplementationOnce(async (request) => {
      entered();
      await wait;
      return { clientOrderId: request.clientOrderId, orderId: '99', status: 'CANCELED' };
    });
    const retiring = f.first.coordinator.reconcileClosed(() => f.store);
    await started;
    const closing = f.first.coordinator.close();
    expect(fs.existsSync(`${f.file}.lock`)).toBe(true);
    expect(() => new FileBackedExecutionJournal(f.file)).toThrow('JOURNAL_WRITER_LOCKED');
    release();
    await Promise.all([retiring, closing]);
    expect(fs.existsSync(`${f.file}.lock`)).toBe(false);
    expect(fs.readFileSync(f.file, 'utf8')).not.toContain('STOP_RETIREMENT_V1');
  });

  it('rejects corrupt retirement evidence on restart rather than clearing historical pending operations', async () => {
    const f = await closedFixture();
    await f.first.coordinator.reconcileClosed(() => f.store);
    await f.first.coordinator.close();
    const history = fs
      .readFileSync(f.file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const entry of history)
      if (entry.metadata.retirement) entry.metadata.retirement.status = 'NEW';
    const corrupt = history.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    fs.writeFileSync(f.file, corrupt);
    await expect(f.make().coordinator.start()).rejects.toThrow('STOP_RETIREMENT_INVALID');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(corrupt);
  });

  it('persists original request, confirms exact receipt, and observes again after restart without resend', async () => {
    const f = fixture();
    const first = f.make();
    expect((await first.run()).status).toBe('PROTECTED');
    const history = fs
      .readFileSync(f.file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(history.map((e) => e.event)).toEqual([
      'PREPARED',
      'SUBMITTED',
      'OPEN_CONFIRMED',
      'PROTECTED',
      'CLOSE_PENDING',
      'CLOSED',
    ]);
    expect(history[0].metadata.request).toMatchObject({
      protocol: 'STOP_MUTATION_V1',
      scope: f.scope,
      parentTradeId: 'trade',
      parentOrderId: '42',
      triggerPrice: 90,
      positionQuantity: 2,
      closePosition: true,
      positionSide: 'BOTH',
    });
    await first.coordinator.close();
    const restarted = f.make();
    await restarted.coordinator.start();
    expect(restarted.coordinator.blockedReason()).toBe('STOP_MUTATION_PENDING');
    expect((await restarted.run()).status).toBe('PROTECTED');
    expect(restarted.coordinator.blockedReason()).toBeUndefined();
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
    expect(f.exchange.placeStopClose).not.toHaveBeenCalled();
    expect(f.exchange.placeTpClose).not.toHaveBeenCalled();
  });

  it('lost response remains pending across restart; visibility resolves it without resend', async () => {
    const f = fixture();
    const original = f.exchange.sendStopCloseOnce.getMockImplementation()!;
    f.exchange.sendStopCloseOnce.mockImplementation(async (r) => {
      await original(r);
      throw new Error('response lost');
    });
    f.hide();
    const first = f.make();
    expect((await first.run()).status).toBe('UNKNOWN');
    await first.coordinator.close();
    const next = f.make();
    expect((await next.run()).status).toBe('UNKNOWN');
    f.show();
    expect((await next.run()).status).toBe('PROTECTED');
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
  });

  it('reconciles before the legacy latch, without treating latch as send permission', async () => {
    const f = fixture();
    const first = f.make();
    f.hide();
    await first.run();
    await first.coordinator.close();
    f.store.set({
      microStopSubmission: { attemptedAt: Date.now(), stopPrice: 90, tradeId: 'trade' },
    });
    f.show();
    expect((await f.make().run()).status).toBe('PROTECTED');
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
  });

  it('legacy latch without identified history does not send', async () => {
    const f = fixture();
    f.store.set({
      microStopSubmission: { attemptedAt: Date.now(), stopPrice: 90, tradeId: 'trade' },
    });
    expect((await f.make().run()).status).toBe('UNKNOWN');
    expect(f.exchange.sendStopCloseOnce).not.toHaveBeenCalled();
  });

  it('identity changing during fsync prevents first send and restart cannot resend PREPARED', async () => {
    const f = fixture();
    let armed = false;
    const io = {
      ...fs,
      fsyncSync: (fd: number) => {
        fs.fsyncSync(fd);
        if (armed) {
          armed = false;
          f.store.set({ lastOrderId: 'other' });
        }
      },
    };
    const first = f.make(f.scope, io);
    await first.coordinator.start();
    armed = true;
    expect((await first.run()).status).toBe('UNKNOWN');
    expect(f.exchange.sendStopCloseOnce).not.toHaveBeenCalled();
    await first.coordinator.close();
    f.store.set({ lastOrderId: '42' });
    expect((await f.make().run()).status).toBe('UNKNOWN');
    expect(f.exchange.sendStopCloseOnce).not.toHaveBeenCalled();
  });

  it('real append fsync failure blocks submission and poisons the coordinator', async () => {
    const f = fixture();
    let armed = false;
    const io = {
      ...fs,
      fsyncSync: (fd: number) => {
        if (armed) throw new Error('injected fsync');
        fs.fsyncSync(fd);
      },
    };
    const first = f.make(f.scope, io);
    await first.coordinator.start();
    armed = true;
    expect((await first.run()).status).toBe('UNKNOWN');
    expect(f.exchange.sendStopCloseOnce).not.toHaveBeenCalled();
    expect(first.coordinator.blockedReason()).toContain('STOP_JOURNAL_BLOCKED');
    armed = false;
    expect((await first.run()).status).toBe('UNKNOWN');
    expect(f.store.get().microProtectionBlocked).toBe(true);
  });

  it('cancelled or missing previously confirmed stop never authorizes a new mutation', async () => {
    const f = fixture();
    const first = f.make();
    await first.run();
    await first.coordinator.close();
    f.hide();
    const next = f.make();
    expect((await next.run()).status).toBe('UNKNOWN');
    expect((await next.run()).status).toBe('UNKNOWN');
    expect(next.coordinator.blockedReason()).toBe('STOP_MUTATION_PENDING');
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'scope conflict rejects startup under the same file, terminal=%s',
    async (terminal) => {
      const f = fixture();
      if (!terminal) f.hide();
      const first = f.make();
      await first.run();
      await first.coordinator.close();
      await expect(f.make({ ...f.scope, account: 'other' }).coordinator.start()).rejects.toThrow(
        'STOP_PROTOCOL_OR_SCOPE_CONFLICT',
      );
      expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
    },
  );

  it('wrong lookup identity or changed position cannot confirm an ACK', async () => {
    const f = fixture();
    f.exchange.readStopCloseByClientOrderId.mockResolvedValue({
      clientOrderId: 'wrong',
      orderId: '99',
    });
    const first = f.make();
    expect((await first.run()).status).toBe('UNKNOWN');
    f.exchange.readStopCloseByClientOrderId.mockImplementation(async (r) => ({
      clientOrderId: r.clientOrderId,
      orderId: '99',
    }));
    f.exchange.readActivePosition.mockResolvedValue({
      sideMode: 'BOTH',
      qtyAbs: 3,
      entryPrice: 100,
      leverage: 10,
    });
    expect((await first.run()).status).toBe('UNKNOWN');
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
  });

  it.each([{ lastOrderId: 'changed' }, { lastStopPrice: 91 }, { lastSide: 'SHORT' as const }])(
    'changed original identity cannot create a fresh mutation after restart: %j',
    async (change) => {
      const f = fixture();
      f.hide();
      const first = f.make();
      await first.run();
      await first.coordinator.close();
      f.store.set(change);
      expect((await f.make().run()).status).toBe('UNKNOWN');
      expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(f.file, 'utf8').match(/"event":"PREPARED"/g)).toHaveLength(1);
    },
  );

  it('close drains a pending transport before releasing the writer', async () => {
    const f = fixture();
    let release!: () => void;
    const original = f.exchange.sendStopCloseOnce.getMockImplementation()!;
    f.exchange.sendStopCloseOnce.mockImplementation(async (r) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(r);
    });
    const first = f.make();
    const running = first.run();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    let closed = false;
    const closing = first.coordinator.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(fs.existsSync(`${f.file}.lock`)).toBe(true);
    release();
    await running;
    await closing;
    expect(fs.existsSync(`${f.file}.lock`)).toBe(false);
  });
});
