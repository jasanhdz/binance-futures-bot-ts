import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStateStore } from '../../infra/logging/FsStateStore';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import {
  DurableEntryCoordinator,
  type DurableEntryRequest,
} from '../execution/DurableEntryCoordinator';
import type { RecoverableEntryPosition, TradingExchangePort } from '../ports/Exchange';
import { MicroEntryRecoveryService } from './MicroEntryRecoveryService';
import { PositionProtectionService } from './PositionProtectionService';
import { DurableStopCoordinator } from '../execution/DurableStopCoordinator';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const now = 1700000010000;
const request: DurableEntryRequest = {
  protocol: 'ENTRY_MUTATION_V1',
  scope: { account: 'fixture', environment: 'fixture' },
  operationId: 'entry-fixture',
  mutationId: 'se_fixture',
  kind: 'OPEN',
  parentTradeId: 'MICRO-BURST-V1-fixture',
  quantity: 2,
  clientOrderId: 'se_fixture',
  intent: {
    identity: {
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: 'v1',
      freezeState: 'DRAFT',
      codeCommitSha: 'fixture',
    },
    tradeId: 'MICRO-BURST-V1-fixture',
    symbol: 'ETHUSDT',
    side: 'LONG',
    requestedAt: now - 1000,
    leverage: 10,
    positionFraction: 0.1,
    structuralStopPrice: 90,
    destinationPrice: 110,
    protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
    metadata: {},
  },
};

function fixture(durableStop = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-recovery-'));
  dirs.push(dir);
  const root = new FsStateStore('default', 'fixture', dir);
  const store = root.forSymbol('ETHUSDT');
  const position = { sideMode: 'BOTH' as const, qtyAbs: 2, entryPrice: 100, leverage: 10 };
  const evidence: RecoverableEntryPosition = {
    source: 'BINANCE_ORDER_AND_TRADES_V1',
    observedAt: now,
    symbol: 'ETHUSDT',
    side: 'LONG',
    clientOrderId: 'se_fixture',
    orderId: '123',
    filledAt: now - 500,
    fillIds: ['1', '2'],
    position,
  };
  const orders: Awaited<ReturnType<TradingExchangePort['listCloseOrdersForSide']>> = [];
  const exchange = {
    sendStopCloseOnce: vi.fn(async (input: { clientOrderId: string }) => ({
      clientOrderId: input.clientOrderId,
      orderId: '987',
    })),
    readStopCloseByClientOrderId: vi.fn(async (input: { clientOrderId: string }) => {
      const sent = exchange.sendStopCloseOnce.mock.calls[0]?.[0];
      return sent?.clientOrderId === input.clientOrderId
        ? { clientOrderId: sent.clientOrderId, orderId: '987' }
        : null;
    }),
    readRecoverableEntryPosition: vi.fn(async () => evidence),
    readActivePosition: vi.fn(async () => position),
    listCloseOrdersForSide: vi.fn(async () => [...orders]),
    getMarkPrice: vi.fn(async () => 100),
    getSymbolFilters: vi.fn(async () => ({
      tickSize: 0.01,
      stepSize: 0.01,
      pricePrecision: 2,
      qtyPrecision: 2,
      minNotional: 5,
    })),
    placeStopClose: vi.fn(async () => {
      expect(new FsStateStore('default', 'fixture', dir).forSymbol('ETHUSDT').get()).toMatchObject({
        lastTradeId: request.parentTradeId,
        microStopSubmission: { tradeId: request.parentTradeId },
      });
      orders.push({
        orderId: 'stop',
        type: 'STOP_MARKET',
        stopPrice: 90,
        owner: 'BOT',
        side: 'SELL',
        positionSide: 'BOTH',
        closePosition: true,
      });
      return true;
    }),
    placeTpClose: vi.fn(),
    marketOpen: vi.fn(),
    closeSideMarketSafe: vi.fn(),
    cancelOrderById: vi.fn(),
  };
  const stopCoordinator = durableStop
    ? new DurableStopCoordinator({
        scope: request.scope,
        journal: () => new FileBackedExecutionJournal(path.join(dir, 'stops.jsonl')),
        exchange: exchange as unknown as TradingExchangePort,
      })
    : undefined;
  const protection = new PositionProtectionService({
    stopCoordinator,
    exchange: exchange as unknown as TradingExchangePort,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getRegimeConfig: () => undefined,
    getImmediateTriggerBufferPct: () => 0.001,
    logTradeEvent: async () => {},
    now: () => now,
    wait: async () => {},
  });
  const service = new MicroEntryRecoveryService({
    exchange,
    stateForSymbol: (symbol) => root.forSymbol(symbol),
    protection,
    now: () => now,
  });
  return { dir, root, store, exchange, evidence, protection, service, stopCoordinator };
}

describe('Micro entry recovery with durable state and the runtime protection service', () => {
  it('hands recovered Micro to the same durable stop path without TP or legacy unidentified send', async () => {
    const f = fixture(true);
    try {
      expect((await f.service.recover(request, { avgPrice: 100, orderId: '123' })).status).toBe(
        'PROTECTED',
      );
      expect(
        (await f.protection.superviseMicroStop('ETHUSDT', f.store.get(), f.store)).status,
      ).toBe('PROTECTED');
      expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
      expect(f.exchange.placeStopClose).not.toHaveBeenCalled();
      expect(f.exchange.placeTpClose).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(f.dir, 'stops.jsonl'), 'utf8')).toContain(
        'STOP_MUTATION_V1',
      );
    } finally {
      await f.stopCoordinator!.close();
    }
  });
  it('rebuilds and protects a blank projection without opening or inventing accounting, then survives restart', async () => {
    const f = fixture();
    expect((await f.service.recover(request, { avgPrice: 100, orderId: '123' })).status).toBe(
      'PROTECTED',
    );
    expect(f.store.get()).toMatchObject({
      mode: 'LONG_RIDE',
      lastTradeId: request.parentTradeId,
      lastEntryAt: now - 500,
      lastStrategy: 'MICRO_BURST_V1',
      bracketsAttached: true,
      microBurstPnlUnverified: true,
      eligibleForBotMetrics: false,
      recoveredEntryMutationId: 'se_fixture',
    });
    expect(f.exchange.marketOpen).not.toHaveBeenCalled();
    expect(f.exchange.placeTpClose).not.toHaveBeenCalled();
    const restartedRoot = new FsStateStore('default', 'fixture', f.dir);
    const recovered = new MicroEntryRecoveryService({
      exchange: f.exchange,
      stateForSymbol: (s) => restartedRoot.forSymbol(s),
      protection: f.protection,
      now: () => now,
    });
    expect((await recovered.recover(request, { avgPrice: 100, orderId: '123' })).status).toBe(
      'PROTECTED',
    );
    expect(f.exchange.placeStopClose).toHaveBeenCalledTimes(1);
  });

  it('does not resend a stop after its response was lost, including reconstruction', async () => {
    const f = fixture();
    f.exchange.placeStopClose.mockRejectedValue(new Error('lost ACK'));
    expect((await f.service.recover(request, { avgPrice: 100, orderId: '123' })).status).toBe(
      'PENDING',
    );
    await f.store.flush!();
    const root = new FsStateStore('default', 'fixture', f.dir);
    const restarted = new MicroEntryRecoveryService({
      exchange: f.exchange,
      stateForSymbol: (s) => root.forSymbol(s),
      protection: f.protection,
      now: () => now,
    });
    expect((await restarted.recover(request, { avgPrice: 100, orderId: '123' })).status).toBe(
      'PENDING',
    );
    expect(f.exchange.placeStopClose).toHaveBeenCalledTimes(1);
  });

  it.each(['occupied', 'during-read', 'during-flush', 'disk', 'wrong-quantity', 'wrong-order'])(
    'keeps recovery blocked without stop mutation for %s',
    async (scenario) => {
      const f = fixture();
      if (scenario === 'occupied') f.store.set({ lastTradeId: 'T2' });
      if (scenario === 'during-read')
        f.exchange.readRecoverableEntryPosition.mockImplementationOnce(async () => {
          f.store.set({ lastTradeId: 'T2' });
          return f.evidence;
        });
      if (scenario === 'during-flush')
        vi.spyOn(f.store, 'flush').mockImplementationOnce(async () => {
          f.store.set({ lastTradeId: 'T2' });
        });
      if (scenario === 'disk') vi.spyOn(f.store, 'flush').mockRejectedValueOnce(new Error('disk'));
      if (scenario === 'wrong-quantity') f.evidence.position.qtyAbs = 1;
      if (scenario === 'wrong-order') f.evidence.orderId = 'other';
      expect((await f.service.recover(request, { avgPrice: 100, orderId: '123' })).status).not.toBe(
        'PROTECTED',
      );
      expect(f.exchange.placeStopClose).not.toHaveBeenCalled();
      if (['occupied', 'during-read', 'during-flush'].includes(scenario))
        expect(f.store.get().lastTradeId).toBe('T2');
      await f.store.flush!();
    },
  );

  it('runs through journal restart recovery, not the live submission callback', async () => {
    const f = fixture();
    const journal = new FileBackedExecutionJournal(path.join(f.dir, 'journal.jsonl'));
    await journal.append({
      id: 'prepared',
      operationId: request.operationId,
      scope: request.scope,
      symbol: request.intent.symbol,
      side: request.intent.side,
      strategyId: request.intent.identity.strategyId,
      clientOrderId: request.clientOrderId,
      quantity: request.quantity,
      event: 'PREPARED',
      timestampMs: now - 1000,
      metadata: { journalOperationMeaning: 'ENTRY_MUTATION_NOT_TRADE', request },
    });
    await journal.close();
    const coordinator = new DurableEntryCoordinator({
      scope: request.scope,
      journal: () => new FileBackedExecutionJournal(path.join(f.dir, 'journal.jsonl')),
      lookup: async () => ({ orderId: '123', avgPrice: 100 }),
      confirmHandoff: async () => false,
    });
    coordinator.registerPositionRecovery(async (r, o) => {
      await f.service.recover(r, o);
    });
    try {
      await coordinator.start();
      expect(f.store.get().bracketsAttached).toBe(true);
      expect(coordinator.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
      await coordinator.reconcile();
      expect(f.exchange.placeStopClose).toHaveBeenCalledTimes(1);
      expect(f.exchange.marketOpen).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
      await f.store.flush!();
    }
  });

  it('does not send the recovered stop if a newer trade appears during its persistence', async () => {
    const f = fixture();
    const flush = f.store.flush.bind(f.store);
    vi.spyOn(f.store, 'flush').mockImplementation(async () => {
      await flush();
      if (f.store.get().microStopSubmission)
        f.store.set({ lastTradeId: 'T2', lastSide: 'SHORT', mode: 'SHORT_RIDE' });
    });
    expect((await f.service.recover(request, { avgPrice: 100, orderId: '123' })).status).toBe(
      'CONFLICT',
    );
    expect(f.exchange.placeStopClose).not.toHaveBeenCalled();
    expect(f.store.get()).toMatchObject({
      lastTradeId: 'T2',
      lastSide: 'SHORT',
      mode: 'SHORT_RIDE',
    });
    await flush();
  });
});
