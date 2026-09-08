import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../infra/config/environment', async (original) => {
  const module = await original<typeof import('../../infra/config/environment')>();
  return {
    ...module,
    CONFIG: { ...module.CONFIG, AEGIS_ENABLED: false, AEGIS_LIVE_ENABLED: true },
  };
});
import { TradingService } from './TradingService';
import { BinanceExchange } from '../../infra/adapters/BinanceAdapter';
import { FsStateStore } from '../../infra/logging/FsStateStore';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import { DurableEntryCoordinator } from '../execution/DurableEntryCoordinator';
import { DurableStopCoordinator } from '../execution/DurableStopCoordinator';
import { DurableCloseCoordinator } from '../execution/DurableCloseCoordinator';
import { SharedStrategyExecutionService } from '../execution/SharedStrategyExecutionService';
import { PositionProtectionService } from '../position/PositionProtectionService';
import { MicroBurstPositionManager } from '../../strategies/micro-burst/application/MicroBurstPositionManager';
import { createMicroBurstContextualIdentity } from '../../strategies/micro-burst/domain/MicroBurstIdentity';
import { sizeMicroBurstLiveEntry } from '../../strategies/micro-burst/application/MicroBurstLiveSizing';
import { validateMicroBurstEntryMarket } from '../../strategies/micro-burst/domain/MicroBurstEntryMarketGuard';
import {
  MicroBurstNetLossLedger,
  microBurstLossResetPayload,
  type MicroBurstLossResetCommand,
} from '../../infra/state/MicroBurstNetLossLedger';
import type { TradingExchangePort } from '../ports/Exchange';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-full-flow-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = new FsStateStore('default', 'flow', dir).forSymbol('ETHUSDT');
  cleanups.push(() => store.flush!());
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const identity = createMicroBurstContextualIdentity('a'.repeat(64), 'b'.repeat(40));
  const risk = {
    sizingMode: 'MARGIN_FRACTION' as const,
    marginFraction: 0.9,
    mediumLeverage: 20 as const,
    highLeverage: 30 as const,
    maxConsecutiveNetLosses: 3 as const,
    resetMode: 'SIGNED_OPERATOR' as const,
    feeReserveBps: 14,
    stopStressBps: 10,
  };
  const config = {
    enabled: true,
    mode: 'LIVE',
    entryPolicy: 'REACTION',
    symbols: { ETHUSDT: { enabled: true } },
    exitPolicy: { contextualPolicyVersion: 'CONTEXTUAL_V3' },
    contextualRisk: risk,
  };
  const scope = { account: 'simulated-account', environment: 'offline' };
  const keys = generateKeyPairSync('ed25519');
  const ledgerOptions = {
    ...scope,
    databasePath: path.join(dir, 'ledger.sqlite'),
    operatorPublicKey: keys.publicKey,
  };
  let ledger = new MicroBurstNetLossLedger(ledgerOptions);
  cleanups.push(() => ledger.close());
  const now = Date.now();
  const command: MicroBurstLossResetCommand = {
    schemaVersion: 1,
    action: 'INITIALIZE',
    ...scope,
    strategyId: 'MICRO_BURST_V1',
    policyVersion: 'CONTEXTUAL_V3',
    expectedRevision: 0,
    nonce: 'offline-full-flow-initialization',
    issuedAtMs: now,
    expiresAtMs: now + 60_000,
    reason: 'Synthetic integration only',
  };
  ledger.applyOperatorCommand(
    command,
    sign(null, microBurstLossResetPayload(command), keys.privateKey).toString('base64'),
  );
  let quantity = 0,
    sequence = 100,
    price = 100,
    leverage = 20;
  let blind = false;
  const trades: any[] = [];
  const orders = new Map<string, any>();
  const stops = new Map<string, any>();
  const filters = {
    tickSize: 0.01,
    stepSize: 0.001,
    qtyPrecision: 3,
    pricePrecision: 2,
    minNotional: 5,
    notionalCap: 50_000,
  };
  const book = () =>
    blind
      ? undefined
      : {
          status: 'HEALTHY' as const,
          observedAtMs: Date.now(),
          askDepth: [{ price: price + 0.01, qty: 100 }],
          bidDepth: [{ price: price - 0.01, qty: 100 }],
        };
  const position = () =>
    quantity
      ? {
          sideMode: 'BOTH' as const,
          qtyAbs: quantity,
          entryPrice: 100,
          leverage,
          isolatedMargin: (quantity * 100) / leverage,
        }
      : null;
  const fill = (side: 'BUY' | 'SELL', q: number, id: string, atPrice: number) => {
    const t = {
      id: ++sequence,
      orderId: Number(id),
      symbol: 'ETHUSDT',
      positionSide: 'BOTH',
      side,
      qty: String(q),
      price: String(atPrice),
      realizedPnl: String(side === 'BUY' ? 0 : (atPrice - 100) * q),
      commission: String(q * atPrice * 0.0005),
      commissionAsset: 'USDT',
      time: Date.now(),
    };
    trades.push(t);
    orders.set(id, {
      ...t,
      orderId: Number(id),
      status: 'FILLED',
      origQty: String(q),
      executedQty: String(q),
    });
  };
  const exchange = Object.create(BinanceExchange.prototype) as BinanceExchange;
  const client = {
    futuresTime: vi.fn(async () => Date.now()),
    futuresAccountInfo: vi.fn(async () => ({
      canTrade: true,
      multiAssetsMargin: false,
      positions: [
        {
          symbol: 'ETHUSDT',
          positionSide: 'BOTH',
          positionAmt: String(quantity),
          isolated: true,
          leverage: String(leverage),
        },
      ],
      assets: [{ asset: 'USDT', walletBalance: '25', availableBalance: '25' }],
    })),
    futuresPositionMode: vi.fn(async () => ({ dualSidePosition: false })),
    futuresLeverageBracket: vi.fn(async () => [
      {
        symbol: 'ETHUSDT',
        brackets: [
          {
            notionalFloor: 0,
            notionalCap: 50_000,
            initialLeverage: 50,
            maintMarginRatio: 0.004,
            cum: 0,
          },
        ],
      },
    ]),
    futuresGetOrder: vi.fn(async ({ orderId }: any) => orders.get(String(orderId))),
    futuresUserTrades: vi.fn(async ({ startTime, endTime }: any) =>
      trades.filter((t) => t.time >= startTime && t.time <= endTime),
    ),
    futuresIncome: vi.fn(async () => []),
  };
  const sendOpen = vi.fn(async (_symbol: string, _side: string, q: number) => {
    expect(fs.readFileSync(path.join(dir, 'entry.jsonl'), 'utf8')).toContain('PREPARED');
    expect(fs.readFileSync(path.join(dir, 'entry.jsonl'), 'utf8')).toContain(
      'contextualSizingEvidence',
    );
    expect(quantity).toBe(0);
    quantity = q;
    const id = String(++sequence);
    fill('BUY', q, id, 100);
    return { avgPrice: 100, orderId: id };
  });
  Object.assign(exchange, {
    cli: client,
    log: logger,
    enqueue: async (work: () => unknown) => work(),
    getExchangeInfoSnapshot: async () => ({
      symbols: [
        {
          symbol: 'ETHUSDT',
          marginAsset: 'USDT',
          quoteAsset: 'USDT',
          status: 'TRADING',
          liquidationFee: '0.005',
        },
      ],
    }),
    microCommissionRate: async () => 0.0005,
    getServerTime: async () => Date.now(),
    getMarkPrice: async () => price,
    setLeverage: async (_s: string, l: number) => {
      leverage = l;
    },
    ensureMarginType: async () => {},
    getUSDTBalance: async () => 25,
    getUSDTAccountSnapshot: async () => ({
      walletBalance: 25,
      availableBalance: 25,
      equityTotal: 25,
    }),
    getSymbolFilters: async () => filters,
    hasOpenPosition: async () => quantity > 0,
    readActivePosition: async (_s: string, side: string) => (side === 'SHORT' ? null : position()),
    readFreshActivePosition: async (_s: string, side: string) =>
      side === 'SHORT' ? null : position(),
    marketOpen: sendOpen,
    sendStopCloseOnce: vi.fn(async (r: any) => {
      if (r.closePosition && [...stops.values()].some((s) => s.status === 'NEW' && s.closePosition))
        throw new Error('simulated -4130 duplicate close-all stop');
      if (
        !r.closePosition &&
        (r.positionSide !== 'BOTH' || r.reduceOnly !== true || r.quantity !== quantity)
      )
        throw new Error('simulated invalid reduce-only coverage');
      const id = String(++sequence);
      stops.set(id, { ...r, orderId: id, status: 'NEW' });
      return { clientOrderId: r.clientOrderId, orderId: id };
    }),
    readStopCloseByClientOrderId: async (r: any) => {
      const s = [...stops.values()].find(
        (s) => s.clientOrderId === r.clientOrderId && s.status === 'NEW',
      );
      return s ? { clientOrderId: s.clientOrderId, orderId: s.orderId } : null;
    },
    readStopCloseState: async (r: any) => {
      const s = [...stops.values()].find((s) => s.clientOrderId === r.clientOrderId);
      return s && s.status !== 'FILLED'
        ? { clientOrderId: s.clientOrderId, orderId: s.orderId, status: s.status }
        : null;
    },
    readTriggeredStop: async (r: any) => {
      const s = [...stops.values()].find(
        (s) => s.clientOrderId === r.clientOrderId && s.status === 'FILLED',
      );
      return s
        ? { clientOrderId: s.clientOrderId, orderId: s.orderId, executedOrderId: s.executedOrderId }
        : null;
    },
    listCloseOrdersForSide: async () =>
      [...stops.values()]
        .filter((s) => s.status === 'NEW')
        .map((s) => ({
          orderId: s.orderId,
          type: 'STOP_MARKET',
          stopPrice: s.triggerPrice,
          side: 'SELL',
          positionSide: 'BOTH',
          owner: 'BOT',
          closePosition: s.closePosition,
          quantity: s.quantity,
          reduceOnly: s.reduceOnly,
        })),
    readCancelTarget: async (r: any) => stops.get(r.orderId)?.status ?? null,
    cancelOrderById: async (_s: string, id: string) => {
      stops.get(id).status = 'CANCELED';
    },
    sendMarketCloseOnce: vi.fn(async (r: any) => {
      const id = String(++sequence);
      fill('SELL', quantity, id, price);
      quantity = 0;
      orders.get(id).clientOrderId = r.clientOrderId;
    }),
    readMarketCloseByClientOrderId: async (r: any) => {
      const o = [...orders.values()].find((o) => o.clientOrderId === r.clientOrderId);
      return o
        ? {
            clientOrderId: r.clientOrderId,
            orderId: String(o.orderId),
            status: 'FILLED',
            executedQuantity: Number(o.executedQty),
          }
        : null;
    },
  });
  const makeEntry = () =>
    new DurableEntryCoordinator({
      scope,
      journal: () => new FileBackedExecutionJournal(path.join(dir, 'entry.jsonl')),
      lookup: async () => null,
      confirmHandoff: async (r, o) =>
        store.get().lastTradeId === r.parentTradeId &&
        store.get().lastOrderId === o.orderId &&
        store.get().bracketsAttached === true,
    });
  const makeStop = () =>
    new DurableStopCoordinator({
      scope,
      exchange,
      journal: () => new FileBackedExecutionJournal(path.join(dir, 'stop.jsonl')),
      wait: async () => {},
    });
  const makeClose = () =>
    new DurableCloseCoordinator({
      scope,
      exchange,
      journal: () => new FileBackedExecutionJournal(path.join(dir, 'close.jsonl')),
    });
  let entry = makeEntry(),
    stop = makeStop(),
    close = makeClose();
  cleanups.push(async () => {
    await entry.close();
    await close.close();
    await stop.close();
  });
  await stop.start();
  await close.start();
  await entry.start();
  const makeProtection = () =>
    new PositionProtectionService({
      exchange,
      stopCoordinator: stop,
      closeCoordinator: close,
      logger,
      wait: async () => {},
      getRegimeConfig: () => undefined,
      getImmediateTriggerBufferPct: () => 0.001,
      logTradeEvent: async () => {},
    });
  let protection = makeProtection();
  const service = Object.create(TradingService.prototype) as any;
  Object.assign(service, {
    acceptingEntries: true,
    activeRuntimeTasks: new Set(),
    microBurstEntryInFlightSymbols: new Set(),
    entryInFlightSymbols: new Set(),
    microBurstIdentity: identity,
    config: { symbols: ['ETHUSDT'] },
    symbolStateStores: new Map([['ETHUSDT', store]]),
    stateForSymbol: () => store,
    deps: {
      state: store,
      exchange,
      logger,
      entryCoordinator: entry,
      stopCoordinator: stop,
      closeCoordinator: close,
      microNetLossLedger: ledger,
      closedTradeOutcomeReader: async () => [],
    },
    positionProtection: protection,
    microAdmissionDiagnostics: { record: vi.fn() },
    historyLogger: { logTradeOpen: vi.fn() },
    getTradingMode: () => 'AEGIS_TURBO_MICRO_LIVE',
    getSymbolMode: () => 'LIVE',
    getLiveAegisSymbols: () => ['ETHUSDT'],
    runtimeConfig: {
      getMicroBurstConfig: () => config,
      getMicroBurstProvenance: () => ({
        configHash: 'a'.repeat(64),
        codeCommitSha: 'b'.repeat(40),
      }),
      getAegisTurboGateConfig: () => ({
        maxTradesPerDay: 100,
        maxConsecutiveLosses: 3,
        minCooldownMs: 0,
        maxLiquidityStress: 0.7,
        dailyLossStopPct: -0.1,
      }),
      getAegisPortfolioRiskConfig: () => ({ enabled: false }),
    },
    riskSession: {
      initializeDailyStartBalance: vi.fn(),
      snapshot: () => ({ dailyStartBalance: 25 }),
      setDailyPnlPct: vi.fn(),
      strategySnapshot: () => ({ tradesToday: 0, consecutiveLosses: 0 }),
      timeSinceLastExitMs: () => Infinity,
      recordConfirmedOpen: vi.fn(),
    },
    strategyRuntimeCoordinator: {
      readLiquidityStatus: () => ({ status: 'FRESH', stress: 0 }),
      readMicroBurstExecutionBook: book,
      readMicroBurstExitMarket: () =>
        blind
          ? null
          : {
              currentPrice: price,
              observedAtMs: Date.now(),
              volatilityBps: 1,
              currentBookPressure: null,
              currentBtcContext: null,
              marketEvidence: null,
            },
    },
  });
  const makeExecution = () =>
    new SharedStrategyExecutionService(exchange, logger, {
      feeBufferPct: 0.05,
      confirmationAttempts: 1,
      confirmationDelaysMs: [],
      maxMarketOpenAttempts: 1,
      entryCoordinator: entry,
      stopCoordinator: stop,
      sizeContextualEntry: (intent, f) => sizeMicroBurstLiveEntry(exchange, intent, f, book),
      isEntryCurrent: (intent, q) =>
        !service.microNetLossBlockedReason() &&
        !validateMicroBurstEntryMarket(
          intent,
          q,
          book(),
          Date.now(),
          (intent.metadata.contextualPolicy as any).config,
          'REACTION',
        ),
    });
  service.sharedStrategyExecution = makeExecution();
  const makeManager = () =>
    new MicroBurstPositionManager(
      {} as any,
      undefined,
      {
        authorizeContextual: (context, digest) =>
          (context.symbolState.get().microBurstTradePolicy as any)?.digest === digest &&
          context.symbolState.get().lastStrategyFreezeState === 'FROZEN_LIVE',
        close: (context) =>
          close.closeManaged(context.symbol, context.symbolState, protection, context.botState),
        moveStop: async (context, decision) =>
          stop.tighten(
            context.symbol,
            context.symbolState,
            Number(decision.requestedStopPrice),
            (context.botState.microBurstTradePolicy as any).digest,
          ),
      },
      true,
    );
  let manager = makeManager();
  service.positionManagerRouter = {
    route: vi.fn(async (i: any, c: any) => ({
      status: 'MANAGED',
      result: await manager.manage(i, c),
    })),
  };
  const request = (episode: number, tier = 20) => ({
    symbol: 'ETHUSDT',
    side: 'LONG',
    signalId: `signal-${episode}`,
    strategyVersion: 'CONTEXTUAL_V3',
    requestedAt: Date.now(),
    leverage: tier,
    positionFraction: 0.9,
    structuralStopPrice: 99.5,
    destinationPrice: 102,
    diagnostics: {
      episodeId: `MBV1-EP-${String(episode).padStart(24, '0')}`,
      signalSnapshotAtMs: Date.now(),
    },
  });
  return {
    service,
    get store() {
      return store;
    },
    exchange,
    client,
    get entry() {
      return entry;
    },
    get stop() {
      return stop;
    },
    get close() {
      return close;
    },
    get protection() {
      return protection;
    },
    book,
    sendOpen,
    request,
    ledger: () => ledger,
    setPrice: (p: number) => {
      price = p;
      clock += 100;
    },
    setBlind: () => {
      blind = true;
    },
    restart: async () => {
      await store.flush();
      await entry.close();
      await close.close();
      await stop.close();
      ledger.close();
      store = new FsStateStore('default', 'flow', dir).forSymbol('ETHUSDT');
      ledger = new MicroBurstNetLossLedger(ledgerOptions);
      entry = makeEntry();
      stop = makeStop();
      close = makeClose();
      await stop.start();
      await close.start();
      await entry.start();
      protection = makeProtection();
      Object.assign(service.deps, {
        state: store,
        microNetLossLedger: ledger,
        entryCoordinator: entry,
        stopCoordinator: stop,
        closeCoordinator: close,
      });
      service.symbolStateStores.set('ETHUSDT', store);
      service.positionProtection = protection;
      service.sharedStrategyExecution = makeExecution();
      manager = makeManager();
    },
    triggerStop: () => {
      const s = [...stops.values()].find((s) => s.status === 'NEW');
      const id = String(++sequence);
      fill('SELL', quantity, id, 99.5);
      quantity = 0;
      s.status = 'FILLED';
      s.executedOrderId = id;
    },
  };
}

describe('V3 production entry/protection/exit/accounting flow with simulated Binance', () => {
  it('retains existing protection after rejected adjustment and never resends across restart', async () => {
    const f = await fixture();
    expect(await f.service.openMicroBurstLivePosition(f.request(1))).toBe(true);
    await f.entry.reconcile();
    f.setPrice(101);
    const policy = f.store.get().microBurstTradePolicy as any;
    vi.mocked(f.exchange.sendStopCloseOnce!).mockRejectedValueOnce(new Error('simulated -2022'));
    expect(await f.stop.tighten('ETHUSDT', f.store, 100.2, policy.digest)).toBe(false);
    expect(f.store.get().lastStopPrice).toBe(99.5);
    expect(await f.exchange.listCloseOrdersForSide('ETHUSDT', 'LONG')).toHaveLength(1);
    await f.restart();
    expect(await f.stop.tighten('ETHUSDT', f.store, 100.2, policy.digest)).toBe(false);
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(2);
    expect(f.store.get().microBurstStopMove).toBeDefined();
    expect(await f.exchange.listCloseOrdersForSide('ETHUSDT', 'LONG')).toHaveLength(1);
  }, 20_000);

  it('does not prepare a quantity stop for hedge or changed position evidence', async () => {
    const f = await fixture();
    expect(await f.service.openMicroBurstLivePosition(f.request(1))).toBe(true);
    await f.entry.reconcile();
    f.setPrice(101);
    const policy = f.store.get().microBurstTradePolicy as any;
    const position = await f.exchange.readFreshActivePosition!('ETHUSDT', 'LONG');
    const read = vi.spyOn(f.exchange, 'readFreshActivePosition');
    for (const changed of [{ sideMode: 'LONG' as const }, { qtyAbs: position!.qtyAbs + 1 }]) {
      read.mockResolvedValueOnce({ ...position!, ...changed });
      expect(await f.stop.tighten('ETHUSDT', f.store, 100.2, policy.digest)).toBe(false);
      expect(f.store.get().microBurstStopMove).toBeUndefined();
    }
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('observes a historical close-all adjustment using its original contract without resending', async () => {
    const f = await fixture();
    expect(await f.service.openMicroBurstLivePosition(f.request(1))).toBe(true);
    await f.entry.reconcile();
    f.setPrice(101);
    const state = f.store.get();
    const policy = state.microBurstTradePolicy as any;
    const key = `${policy.digest}:100.2`;
    expect(
      await f.stop.supervise(
        {
          symbol: 'ETHUSDT',
          side: 'LONG',
          positionSide: 'BOTH',
          triggerPrice: 100.2,
          closePosition: true,
          workingType: 'MARK_PRICE',
          parentTradeId: state.lastTradeId!,
          parentOrderId: state.lastOrderId!,
          strategyId: state.lastStrategy!,
          positionQuantity: state.lastEntryQty!,
          entryPrice: state.lastEntryPrice!,
          replacementKey: key,
        },
        () => true,
        true,
      ),
    ).toBe(false);
    f.store.set({ microBurstStopMove: { key, triggerPrice: 100.2, policyDigest: policy.digest } });
    await f.restart();
    const read = vi.spyOn(f.exchange, 'readStopCloseByClientOrderId');
    expect(await f.stop.tighten('ETHUSDT', f.store, 100.2, policy.digest)).toBe(false);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ closePosition: true, replacementKey: key }),
    );
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(2);
    expect(f.store.get().lastStopPrice).toBe(99.5);
  }, 20_000);

  it('recovers an ambiguous stop adjustment by observation without a second send', async () => {
    const f = await fixture();
    expect(await f.service.openMicroBurstLivePosition(f.request(1))).toBe(true);
    await f.entry.reconcile();
    f.setPrice(101);
    const policy = f.store.get().microBurstTradePolicy as any;
    const read = f.exchange.readStopCloseByClientOrderId!.bind(f.exchange);
    vi.spyOn(f.exchange, 'readStopCloseByClientOrderId').mockResolvedValueOnce(null);
    expect(await f.stop.tighten('ETHUSDT', f.store, 100.2, policy.digest)).toBe(false);
    expect(f.store.get().lastStopPrice).toBe(99.5);
    expect(f.store.get().microBurstStopMove).toBeDefined();
    vi.mocked(f.exchange.readStopCloseByClientOrderId!).mockImplementation(read);
    await f.restart();
    expect((await f.protection.superviseMicroStop('ETHUSDT', f.store.get(), f.store)).status).toBe(
      'PROTECTED',
    );
    expect(f.store.get().lastStopPrice).toBe(100.2);
    expect(f.store.get().microBurstStopMove).toBeUndefined();
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('persists a tighter covering stop before using it for subsequent supervision', async () => {
    const f = await fixture();
    expect(await f.service.openMicroBurstLivePosition(f.request(1))).toBe(true);
    await f.entry.reconcile();
    f.setPrice(101);
    const policy = f.store.get().microBurstTradePolicy as any;
    expect(await f.stop.tighten('ETHUSDT', f.store, 100.191, policy.digest)).toBe(true);
    expect(f.store.get().lastStopPrice).toBe(100.2);
    expect(f.store.get().microBurstActiveStopKey).toBe(`${policy.digest}:100.2`);
    const supervision = await f.protection.superviseMicroStop('ETHUSDT', f.store.get(), f.store);
    expect(supervision.status).toBe('PROTECTED');
    expect(await f.stop.tighten('ETHUSDT', f.store, 100.1, policy.digest)).toBe(false);
    expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.exchange.sendStopCloseOnce!).mock.calls[1][0]).toMatchObject({
      closePosition: false,
      reduceOnly: true,
      positionSide: 'BOTH',
      quantity: f.store.get().lastEntryQty,
    });
    expect(await f.exchange.listCloseOrdersForSide('ETHUSDT', 'LONG')).toHaveLength(2);
  }, 20_000);

  it('advances a persisted blind timer without fake price/MFE and closes after restart', async () => {
    const f = await fixture();
    expect(await f.service.openMicroBurstLivePosition(f.request(1))).toBe(true);
    await f.entry.reconcile();
    f.setBlind();
    await f.service.managePositionByOwner('ETHUSDT', f.store.get(), f.store);
    const exitState = f.store.get().microBurstExitState as any;
    expect(exitState.contextual.blindSinceMs).toBeTypeOf('number');
    expect(exitState.contextual.peakPrice).toBe(100);
    await f.restart();
    const later = Date.now() + 16_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await f.service.managePositionByOwner('ETHUSDT', f.store.get(), f.store);
    expect(f.store.get().mode).toBe('IDLE');
    expect(f.exchange.sendMarketCloseOnce).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('opens at 20/30 with a persisted policy, confirms structural stops, settles three net losses and latches across restart', async () => {
    const f = await fixture();
    for (let i = 1; i <= 3; i++) {
      f.setPrice(100);
      const opened = await f.service.openMicroBurstLivePosition(f.request(i, i === 2 ? 30 : 20));
      expect(
        opened,
        JSON.stringify({
          episode: i,
          admission: f.service.microAdmissionDiagnostics.record.mock.calls,
        }),
      ).toBe(true);
      const state = f.store.get();
      expect(state.bracketsAttached).toBe(true);
      expect(state.lastStrategyVersion).toBe('CONTEXTUAL_V3');
      expect(state.lastEntryQty).toBeGreaterThan(0);
      expect(
        state.lastEntryMargin! + (state.lastEntryQty! * 100 * 14) / 10_000,
      ).toBeLessThanOrEqual(22.5);
      await f.entry.reconcile();
      f.setPrice(99);
      await f.service.managePositionByOwner('ETHUSDT', f.store.get(), f.store);
      expect(
        f.store.get().mode,
        JSON.stringify(await f.service.positionManagerRouter.route.mock.results.at(-1)?.value),
      ).toBe('IDLE');
      await f.stop.reconcileClosed(() => f.store);
      await f.service.reconcileMicroNetSettlements();
      expect(f.store.get().microBurstPnlUnverified).toBe(false);
      expect(f.ledger().snapshot().consecutiveLosses).toBe(i);
      await f.restart();
    }
    expect(f.service.microNetLossBlockedReason()).toBe('MICRO_THREE_NET_LOSSES_LATCHED');
    expect(await f.service.openMicroBurstLivePosition(f.request(4))).toBe(false);
    expect(f.sendOpen).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('accounts an exact triggered stop through retirement instead of estimating flat PnL', async () => {
    const f = await fixture();
    expect(await f.service.openMicroBurstLivePosition(f.request(1))).toBe(true);
    await f.entry.reconcile();
    f.triggerStop();
    expect(await f.protection.reconcileMissingMicroPosition('ETHUSDT', f.store)).toBe(true);
    await f.stop.reconcileClosed(() => f.store);
    expect(f.store.get().microBurstStopCloseOrderIds).toHaveLength(1);
    await f.service.reconcileMicroNetSettlements();
    expect(f.ledger().snapshot().consecutiveLosses).toBe(1);
    expect(f.store.get().microBurstPnlUnverified).toBe(false);
    expect(f.exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
  }, 20_000);

  it('does not submit without actual fee/tier evidence, matched policy or a new episode', async () => {
    const f = await fixture();
    f.client.futuresLeverageBracket.mockResolvedValueOnce([]);
    expect(await f.service.openMicroBurstLivePosition(f.request(1))).toBe(false);
    expect(f.sendOpen).not.toHaveBeenCalled();
    expect(
      await f.service.openMicroBurstLivePosition({ ...f.request(2), strategyVersion: 'REACTION' }),
    ).toBe(false);
    expect(await f.service.openMicroBurstLivePosition(f.request(3))).toBe(true);
    await f.entry.reconcile();
    f.setPrice(99);
    await f.service.managePositionByOwner('ETHUSDT', f.store.get(), f.store);
    await f.stop.reconcileClosed(() => f.store);
    await f.service.reconcileMicroNetSettlements();
    f.setPrice(100);
    expect(await f.service.openMicroBurstLivePosition(f.request(3))).toBe(false);
    expect(f.sendOpen).toHaveBeenCalledTimes(1);
  }, 20_000);
});
