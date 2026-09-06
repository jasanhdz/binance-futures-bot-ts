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
    listCloseOrdersForSide: vi.fn(async () => []),
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
  };
  const make = (customScope = scope, io = fs) => {
    const coordinator = new DurableStopCoordinator({
      scope: customScope,
      exchange: exchange as unknown as TradingExchangePort,
      journal: () => new FileBackedExecutionJournal(file, io),
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
