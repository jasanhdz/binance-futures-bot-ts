import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileBackedExecutionJournal,
  InMemoryExecutionJournal,
  type ExecutionJournal,
  type JournalEventType,
} from '../../core/risk/ExecutionJournal';
import type { StrategyExecutionIntent } from '../../core/strategy/StrategyExecution';
import type { TradingExchangePort } from '../ports/Exchange';
import {
  DurableEntryCoordinator,
  type DurableEntryRequest,
  definiteEntryRejectionCode,
} from './DurableEntryCoordinator';
import { SharedStrategyExecutionService } from './SharedStrategyExecutionService';
import { DurableStopCoordinator } from './DurableStopCoordinator';
import { validateMicroBurstEntryMarket } from '../../strategies/micro-burst/domain/MicroBurstEntryMarketGuard';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import { createMicroBurstTradePolicy } from '../../strategies/micro-burst/domain/MicroBurstTradePolicy';

const scope = { account: 'fixture-primary', environment: 'fixture' };
const order = { avgPrice: 100, orderId: '123' };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const directories: string[] = [];
const coordinators: DurableEntryCoordinator[] = [];

describe('V3 durable episode identity', () => {
  function contextual(): StrategyExecutionIntent {
    const request = intent();
    request.identity.strategyVersion = 'CONTEXTUAL_V3';
    request.identity.codeCommitSha = 'b'.repeat(40);
    request.identity.configHash = `sha256:${'a'.repeat(64)}`;
    request.positionFraction = 0.9;
    request.metadata.contextualPolicy = createMicroBurstTradePolicy(request.identity, {
      sizingMode: 'MARGIN_FRACTION',
      marginFraction: 0.9,
      mediumLeverage: 20,
      highLeverage: 30,
      maxConsecutiveNetLosses: 3,
      resetMode: 'SIGNED_OPERATOR',
      feeReserveBps: 14,
      stopStressBps: 10,
    });
    request.metadata.episodeId = `MBV1-EP-${'a'.repeat(24)}`;
    return request;
  }
  it('does not resend a confirmed episode after restart with new trade/order/config IDs', async () => {
    const h = harness();
    await h.coordinator.start();
    const first = contextual();
    const send = vi.fn().mockResolvedValue(order);
    expect((await h.coordinator.execute(first, 2, 'se_first', send)).status).toBe('CONFIRMED');
    await h.coordinator.close();
    const recovered = reopen(h.file, async () => null);
    await recovered.coordinator.start();
    const duplicate = contextual();
    duplicate.tradeId = 'new-trade';
    duplicate.identity.configHash = `sha256:${'b'.repeat(64)}`;
    duplicate.metadata.contextualPolicy = createMicroBurstTradePolicy(duplicate.identity, {
      sizingMode: 'MARGIN_FRACTION',
      marginFraction: 0.9,
      mediumLeverage: 20,
      highLeverage: 30,
      maxConsecutiveNetLosses: 3,
      resetMode: 'SIGNED_OPERATOR',
      feeReserveBps: 14,
      stopStressBps: 10,
    });
    expect(await recovered.coordinator.execute(duplicate, 1, 'se_new', send)).toMatchObject({
      status: 'BLOCKED',
      reason: 'ENTRY_MUTATION_ALREADY_RECORDED',
    });
    expect(send).toHaveBeenCalledTimes(1);
    duplicate.metadata.episodeId = `MBV1-EP-${'c'.repeat(24)}`;
    expect(
      (await recovered.coordinator.execute(duplicate, 1, 'se_next_episode', send)).status,
    ).toBe('CONFIRMED');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not resend UNKNOWN after a crash and missing lookup', async () => {
    const h = harness();
    await h.coordinator.start();
    const send = vi.fn().mockRejectedValue(new Error('timeout after exchange accepted'));
    expect((await h.coordinator.execute(contextual(), 2, 'se_unknown', send)).status).toBe(
      'UNKNOWN',
    );
    await h.coordinator.close();
    const recovered = reopen(h.file, async () => null);
    await recovered.coordinator.start();
    expect(await recovered.coordinator.execute(contextual(), 2, 'se_retry', send)).toMatchObject({
      status: 'BLOCKED',
      reason: 'ENTRY_MUTATION_PENDING',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('requires an exact contextual episode and fails closed on a pre-send flush failure', async () => {
    const h = harness();
    await h.coordinator.start();
    const send = vi.fn().mockResolvedValue(order);
    const request = contextual();
    delete request.metadata.episodeId;
    expect(await h.coordinator.execute(request, 2, 'se_missing', send)).toMatchObject({
      status: 'BLOCKED',
      reason: 'MICRO_DURABLE_EPISODE_REQUIRED',
    });
    vi.spyOn(h.journal, 'flush').mockRejectedValueOnce(new Error('disk unavailable'));
    expect((await h.coordinator.execute(contextual(), 2, 'se_flush', send)).status).toBe('UNKNOWN');
    expect(send).not.toHaveBeenCalled();
  });
});

function intent(): StrategyExecutionIntent {
  return {
    identity: {
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: 'v1',
      freezeState: 'DRAFT',
      codeCommitSha: 'fixture',
    },
    tradeId: 'micro-fixture-1',
    symbol: 'ETHUSDT',
    side: 'LONG',
    requestedAt: 1000,
    leverage: 20,
    positionFraction: 0.1,
    structuralStopPrice: 99,
    protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
    metadata: { fixture: true },
  };
}

function harness(journal?: ExecutionJournal) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-entry-'));
  directories.push(directory);
  const file = path.join(directory, 'entries.jsonl');
  const storage = journal ?? new FileBackedExecutionJournal(file);
  const lookup = vi
    .fn<(request: DurableEntryRequest) => Promise<typeof order | null>>()
    .mockResolvedValue(null);
  const confirmHandoff = vi.fn(async () => true);
  const coordinator = new DurableEntryCoordinator({
    scope,
    journal: () => storage,
    lookup,
    confirmHandoff,
  });
  coordinators.push(coordinator);
  return { coordinator, journal: storage, lookup, file, confirmHandoff };
}

function reopen(
  file: string,
  lookup: (request: DurableEntryRequest) => Promise<typeof order | null>,
) {
  const journal = new FileBackedExecutionJournal(file);
  const coordinator = new DurableEntryCoordinator({
    scope,
    journal: () => journal,
    lookup,
    confirmHandoff: async () => true,
  });
  coordinators.push(coordinator);
  return { coordinator, journal };
}

async function seedPrepared(journal: ExecutionJournal): Promise<DurableEntryRequest> {
  const request: DurableEntryRequest = {
    protocol: 'ENTRY_MUTATION_V1',
    scope,
    operationId: 'fixture-mutation-operation',
    mutationId: 'se_fixture',
    kind: 'OPEN',
    parentTradeId: intent().tradeId,
    intent: intent(),
    quantity: 2,
    clientOrderId: 'se_fixture',
  };
  await journal.append({
    id: 'prepared-fixture',
    operationId: request.operationId,
    scope,
    symbol: 'ETHUSDT',
    side: 'LONG',
    strategyId: 'MICRO_BURST_V1',
    event: 'PREPARED',
    timestampMs: 1000,
    quantity: 2,
    leverage: 20,
    clientOrderId: request.clientOrderId,
    metadata: { journalOperationMeaning: 'ENTRY_MUTATION_NOT_TRADE', request },
  });
  return request;
}

function shared(coordinator: DurableEntryCoordinator) {
  const exchange = {
    setLeverage: vi.fn(),
    ensureMarginType: vi.fn(),
    getUSDTBalance: vi.fn().mockResolvedValue(100),
    getUSDTAccountSnapshot: vi.fn().mockResolvedValue({ availableBalance: 100 }),
    getMarkPrice: vi.fn().mockResolvedValue(100),
    getSymbolFilters: vi.fn().mockResolvedValue({
      tickSize: 0.01,
      stepSize: 0.001,
      pricePrecision: 2,
      qtyPrecision: 3,
      minNotional: 5,
    }),
    marketOpen: vi.fn().mockResolvedValue(order),
    readActivePosition: vi
      .fn()
      .mockResolvedValue({ sideMode: 'BOTH', qtyAbs: 2, entryPrice: 100, leverage: 20 }),
    placeStopClose: vi.fn().mockResolvedValue(true),
    placeTpClose: vi.fn(),
    listCloseOrdersForSide: vi.fn().mockResolvedValue([
      {
        orderId: 'stop',
        type: 'STOP_MARKET',
        stopPrice: 99,
        side: 'SELL',
        positionSide: 'BOTH',
        workingType: 'MARK_PRICE',
        closePosition: true,
        owner: 'BOT',
      },
    ]),
    getServerTime: vi.fn().mockResolvedValue(2000),
    closeSideMarketSafe: vi.fn(),
    cancelOrderById: vi.fn(),
  };
  const service = new SharedStrategyExecutionService(
    exchange as unknown as TradingExchangePort,
    logger,
    {
      feeBufferPct: 0,
      confirmationAttempts: 1,
      confirmationDelaysMs: [0],
      protectionVerificationDelaysMs: [0],
      maxMarketOpenAttempts: 2,
      entryCoordinator: coordinator,
    },
  );
  return { service, exchange };
}

it('does not send when Micro market evidence expires while PREPARED is persisted', async () => {
  let now = 1000;
  const journal = new InMemoryExecutionJournal();
  const append = journal.append.bind(journal);
  vi.spyOn(journal, 'append').mockImplementation(async (entry) => {
    const persisted = await append(entry);
    if (entry.event === 'PREPARED') now += 30_001;
    return persisted;
  });
  const h = harness(journal);
  await h.coordinator.start();
  const request = {
    ...intent(),
    structuralStopPrice: 99.5,
    destinationPrice: 102,
    metadata: { signalSnapshotAtMs: 1000 },
  };
  const send = vi.fn().mockResolvedValue(order);
  const reason = () =>
    validateMicroBurstEntryMarket(
      request,
      2,
      {
        status: 'HEALTHY',
        observedAtMs: now,
        bidDepth: [{ price: 99.99, qty: 10 }],
        askDepth: [{ price: 100.01, qty: 10 }],
      },
      now,
      defaultMicroBurstConfig(),
    );
  expect(reason()).toBeUndefined();
  const result = await h.coordinator.execute(request, 2, 'micro-expiry', send, () => !reason());
  expect(result).toMatchObject({ status: 'BLOCKED', reason: 'ENTRY_IDENTITY_NOT_CURRENT' });
  expect(reason()).toBe('MICRO_SIGNAL_EXPIRED');
  expect(send).not.toHaveBeenCalled();
  expect(h.coordinator.blockedReason()).toBeDefined();
});

afterEach(async () => {
  for (const coordinator of coordinators.splice(0))
    await coordinator.close().catch(() => undefined);
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('durable entry aperture', () => {
  it.each(['protection', 'emergency'] as const)(
    'excludes entry recovery throughout live Shared %s handling and drains before restart',
    async (stage) => {
      const f = harness();
      f.confirmHandoff.mockResolvedValue(false);
      const recover = vi.fn(async () => undefined);
      f.coordinator.registerPositionRecovery(recover);
      await f.coordinator.start();
      const { exchange } = shared(f.coordinator);
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const sendStopCloseOnce = vi.fn(async (request: { clientOrderId: string }) => {
        entered();
        await held;
        return { clientOrderId: request.clientOrderId, orderId: 'stop-1' };
      });
      exchange.closeSideMarketSafe.mockImplementation(async () => {
        entered();
        await held;
        exchange.readActivePosition.mockResolvedValue(null);
      });
      exchange.listCloseOrdersForSide.mockResolvedValue([]);
      const port = {
        ...exchange,
        sendStopCloseOnce,
        readStopCloseByClientOrderId: vi.fn(async (request: { clientOrderId: string }) => ({
          clientOrderId: request.clientOrderId,
          orderId: 'stop-1',
        })),
      };
      const stops = new DurableStopCoordinator({
        scope,
        journal: () => new FileBackedExecutionJournal(f.file + '.stops'),
        exchange: port as unknown as TradingExchangePort,
      });
      const service = new SharedStrategyExecutionService(
        port as unknown as TradingExchangePort,
        logger,
        {
          feeBufferPct: 0,
          confirmationAttempts: 1,
          confirmationDelaysMs: [0],
          maxMarketOpenAttempts: 1,
          entryCoordinator: f.coordinator,
          stopCoordinator: stops,
        },
      );
      try {
        await stops.start();
        const execution = service.execute({
          ...intent(),
          structuralStopPrice: stage === 'emergency' ? 101 : 99,
        });
        await started;
        const [id] = await f.journal.listNonTerminal();
        expect((await f.journal.readLatest(id))?.event).toBe('OPEN_CONFIRMED');
        f.confirmHandoff.mockClear();
        await f.coordinator.reconcile();
        await f.coordinator.reconcile();
        expect(recover).not.toHaveBeenCalled();
        expect(f.confirmHandoff).not.toHaveBeenCalled();
        expect(f.coordinator.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
        expect((await service.execute(intent())).status).toBe('DENIED');
        let drained = false;
        const closing = f.coordinator.close().then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);
        expect(() => new FileBackedExecutionJournal(f.file)).toThrow('JOURNAL_WRITER_LOCKED');
        release();
        expect((await execution).status).toBe(stage === 'emergency' ? 'FAILED' : 'OPENED');
        await closing;
        expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
        expect(sendStopCloseOnce).toHaveBeenCalledTimes(stage === 'protection' ? 1 : 0);
        expect(exchange.closeSideMarketSafe).toHaveBeenCalledTimes(stage === 'emergency' ? 1 : 0);
        expect(exchange.cancelOrderById).not.toHaveBeenCalled();
        const journal = new FileBackedExecutionJournal(f.file);
        const restarted = new DurableEntryCoordinator({
          scope,
          journal: () => journal,
          lookup: async () => null,
          confirmHandoff: async () => false,
        });
        coordinators.push(restarted);
        restarted.registerPositionRecovery(recover);
        await restarted.start();
        expect(recover).toHaveBeenCalledTimes(1);
        expect((await journal.readLatest(id))?.event).toBe('OPEN_CONFIRMED');
        expect(restarted.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
      } finally {
        release();
        await stops.close();
      }
    },
  );

  it('releases live exclusion after a failed observation so later recovery remains reachable', async () => {
    const f = harness();
    f.confirmHandoff.mockResolvedValue(false);
    const recover = vi.fn(async () => undefined);
    f.coordinator.registerPositionRecovery(recover);
    await f.coordinator.start();
    const result = await f.coordinator.execute(intent(), 2, 'se_live', async () => order);
    await expect(
      f.coordinator.withLiveHandoff(async () => {
        await f.coordinator.reconcile();
        expect(recover).not.toHaveBeenCalled();
        throw new Error('observation unavailable');
      }),
    ).rejects.toThrow('observation unavailable');
    await f.coordinator.reconcile();
    expect(recover).toHaveBeenCalledTimes(1);
    expect((await f.journal.readLatest(result.operationId))?.event).toBe('OPEN_CONFIRMED');
    expect(f.coordinator.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
  });

  it('waits for already-running recovery before entering live handoff', async () => {
    const f = harness();
    f.confirmHandoff.mockResolvedValue(false);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.coordinator.registerPositionRecovery(async () => {
      entered();
      await held;
    });
    await f.coordinator.start();
    await f.coordinator.execute(intent(), 2, 'se_live', async () => order);
    const recovery = f.coordinator.reconcile();
    await started;
    const work = vi.fn(async () => undefined);
    const live = f.coordinator.withLiveHandoff(work);
    await Promise.resolve();
    expect(work).not.toHaveBeenCalled();
    release();
    await recovery;
    await live;
    expect(work).toHaveBeenCalledTimes(1);
  });

  it.each(['LONG', 'SHORT'] as const)(
    'retains emergency risk reduction for confirmed %s exposure with invalid structural geometry before stop submission',
    async (side) => {
      const f = harness();
      f.confirmHandoff.mockResolvedValue(false);
      await f.coordinator.start();
      const { exchange } = shared(f.coordinator);
      const stopJournal = new FileBackedExecutionJournal(f.file + '.stops');
      const sendStopCloseOnce = vi.fn();
      const port = { ...exchange, sendStopCloseOnce, readStopCloseByClientOrderId: vi.fn() };
      const stops = new DurableStopCoordinator({
        scope,
        journal: () => stopJournal,
        exchange: port as unknown as TradingExchangePort,
      });
      const service = new SharedStrategyExecutionService(
        port as unknown as TradingExchangePort,
        logger,
        {
          feeBufferPct: 0,
          confirmationAttempts: 1,
          confirmationDelaysMs: [0],
          maxMarketOpenAttempts: 1,
          entryCoordinator: f.coordinator,
          stopCoordinator: stops,
          captureProtectionIdentity: () => () => true,
        },
      );
      const position = { sideMode: 'BOTH', qtyAbs: 2, entryPrice: 100, leverage: 20 };
      exchange.readActivePosition
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position)
        .mockResolvedValueOnce(null);
      exchange.listCloseOrdersForSide.mockResolvedValue([]);
      try {
        await stops.start();
        const result = await service.execute({
          ...intent(),
          side,
          structuralStopPrice: side === 'LONG' ? 101 : 99,
        });
        expect(result).toMatchObject({
          status: 'FAILED',
          reason: 'BRACKETS_FAILED',
          metadata: {
            reasonDetail: 'invalid_structural_stop_geometry',
            positionStillOpen: false,
            orderId: '123',
            entryPrice: 100,
          },
        });
        expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
        expect(sendStopCloseOnce).not.toHaveBeenCalled();
        expect(exchange.placeStopClose).not.toHaveBeenCalled();
        expect(exchange.closeSideMarketSafe).toHaveBeenCalledExactlyOnceWith(
          'ETHUSDT',
          side,
          2,
          'BOTH',
          'SHARED_EXECUTION_PROTECTION_FAILED',
        );
        expect(exchange.cancelOrderById).not.toHaveBeenCalled();
        expect(await stopJournal.listOperations()).toEqual([]);
        const [id] = await f.journal.listNonTerminal();
        expect((await f.journal.readLatest(id))?.event).toBe('OPEN_CONFIRMED');
        expect(f.coordinator.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
      } finally {
        await stops.close();
      }
    },
  );

  it.each(['confirmed', 'lost-ack-visible', 'lost-ack-hidden', 'identity-changed'])(
    'routes initial Micro stop through its durable journal: %s',
    async (scenario) => {
      const f = harness();
      f.confirmHandoff.mockResolvedValue(false);
      await f.coordinator.start();
      const { exchange } = shared(f.coordinator);
      const file = f.file + '.stops';
      const journal = new FileBackedExecutionJournal(file);
      let current = true;
      let received: import('../ports/Exchange').IdentifiedStopRequest | undefined;
      const send = vi.fn(async (request: import('../ports/Exchange').IdentifiedStopRequest) => {
        expect(fs.readFileSync(file, 'utf8')).toContain('PREPARED');
        received = request;
        if (scenario.startsWith('lost-ack')) throw new Error('response lost');
        return { clientOrderId: request.clientOrderId, orderId: 'stop-1' };
      });
      const lookup = vi.fn(async (request: import('../ports/Exchange').IdentifiedStopRequest) =>
        received && scenario !== 'lost-ack-hidden'
          ? { clientOrderId: request.clientOrderId, orderId: 'stop-1' }
          : null,
      );
      const port = {
        ...exchange,
        sendStopCloseOnce: send,
        readStopCloseByClientOrderId: lookup,
      } as unknown as TradingExchangePort;
      const stops = new DurableStopCoordinator({ scope, journal: () => journal, exchange: port });
      exchange.listCloseOrdersForSide.mockResolvedValue([]);
      if (scenario === 'identity-changed') {
        const append = journal.append.bind(journal);
        vi.spyOn(journal, 'append').mockImplementation(async (entry) => {
          const saved = await append(entry);
          if (entry.event === 'PREPARED') current = false;
          return saved;
        });
      }
      const service = new SharedStrategyExecutionService(port, logger, {
        feeBufferPct: 0,
        confirmationAttempts: 1,
        confirmationDelaysMs: [0],
        protectionVerificationDelaysMs: [0],
        maxMarketOpenAttempts: 1,
        entryCoordinator: f.coordinator,
        stopCoordinator: stops,
        captureProtectionIdentity: () => () => current,
      });
      try {
        await stops.start();
        const result = await service.execute(intent());
        expect(result.status).toBe(
          scenario === 'confirmed' || scenario === 'lost-ack-visible' ? 'OPENED' : 'FAILED',
        );
        expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(scenario === 'identity-changed' ? 0 : 1);
        expect(exchange.placeStopClose).not.toHaveBeenCalled();
        expect(exchange.placeTpClose).not.toHaveBeenCalled();
        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
        expect(exchange.cancelOrderById).not.toHaveBeenCalled();
        expect(f.coordinator.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
        if (result.status === 'FAILED')
          expect(result.metadata).toMatchObject({
            positionStillOpen: true,
            protectionPending: true,
            orderId: '123',
          });
        await stops.close();
        const restarted = new DurableStopCoordinator({
          scope,
          journal: () => new FileBackedExecutionJournal(file),
          exchange: port,
        });
        try {
          await restarted.start();
          await restarted.supervise(
            {
              symbol: 'ETHUSDT',
              side: 'LONG',
              positionSide: 'BOTH',
              triggerPrice: 99,
              closePosition: true,
              workingType: 'MARK_PRICE',
              parentTradeId: intent().tradeId,
              parentOrderId: '123',
              strategyId: 'MICRO_BURST_V1',
              positionQuantity: 2,
              entryPrice: 100,
            },
            () => true,
            true,
          );
          expect(send).toHaveBeenCalledTimes(scenario === 'identity-changed' ? 0 : 1);
        } finally {
          await restarted.close();
        }
      } finally {
        await stops.close();
      }
    },
  );
  it.each(['AEGIS_TURBO', 'MOMENTUM_RIDE', 'MICRO_BURST_V1'] as const)(
    'routes %s intents through the same Shared mutation boundary',
    async (strategyId) => {
      const { coordinator, journal } = harness();
      await coordinator.start();
      const { service, exchange } = shared(coordinator);
      const value = intent();
      value.identity.strategyId = strategyId;
      const result = await service.execute(value);
      expect(result.status).toBe('OPENED');
      const mutation = (result.metadata.entryMutations as Array<{ operationId: string }>)[0];
      expect(await journal.readLatest(mutation.operationId)).toMatchObject({
        event: 'CLOSED',
        strategyId,
        metadata: { request: { intent: value } },
      });
      expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
    },
  );

  it('persists no request and sends nothing when the current-admission callback denies', async () => {
    const { coordinator, journal } = harness();
    await coordinator.start();
    const send = vi.fn();
    const result = await coordinator.execute(intent(), 2, 'se_denied', send, () => false);
    expect(result).toMatchObject({ status: 'BLOCKED', reason: 'ENTRY_IDENTITY_NOT_CURRENT' });
    expect(await journal.read(result.operationId)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(coordinator.blockedReason()).toBeUndefined();
  });

  it('does not send when PREPARED cannot become durable', async () => {
    const { coordinator, journal } = harness();
    await coordinator.start();
    vi.spyOn(journal, 'append').mockRejectedValue(new Error('disk unavailable'));
    const send = vi.fn();
    expect(await coordinator.execute(intent(), 2, 'se_disk', send)).toMatchObject({
      status: 'UNKNOWN',
    });
    expect(send).not.toHaveBeenCalled();
    expect(coordinator.blockedReason()).toBe('ENTRY_JOURNAL_UNCERTAIN');
  });

  it('is lazy and startup-closed, with zero sends before initialization', async () => {
    const journal = new InMemoryExecutionJournal();
    const factory = vi.fn(() => journal);
    const coordinator = new DurableEntryCoordinator({
      scope,
      journal: factory,
      lookup: async () => null,
      confirmHandoff: async () => false,
    });
    coordinators.push(coordinator);
    const send = vi.fn();
    expect(factory).not.toHaveBeenCalled();
    expect(await coordinator.execute(intent(), 2, 'se_1', send)).toMatchObject({
      status: 'BLOCKED',
      reason: 'ENTRY_RECOVERY_NOT_INITIALIZED',
    });
    expect(send).not.toHaveBeenCalled();
    await coordinator.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(coordinator.blockedReason()).toBeUndefined();
  });

  it('runs real Shared + coordinator + fs journal, placing the Micro stop and no TP', async () => {
    const { coordinator, journal, file } = harness();
    await coordinator.start();
    const { service, exchange } = shared(coordinator);
    exchange.marketOpen.mockImplementation(async () => {
      const records = fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: 'PREPARED',
        metadata: {
          journalOperationMeaning: 'ENTRY_MUTATION_NOT_TRADE',
          request: {
            kind: 'OPEN',
            parentTradeId: 'micro-fixture-1',
            quantity: 2,
            intent: intent(),
          },
        },
      });
      expect(records[0].operationId).not.toBe(records[0].metadata.request.parentTradeId);
      expect(records[0].operationId).not.toBe(records[0].clientOrderId);
      return order;
    });
    const result = await service.execute(intent());
    expect(result.status).toBe('OPENED');
    expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 99);
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    const mutation = (result.metadata.entryMutations as Array<{ operationId: string }>)[0];
    expect((await journal.read(mutation.operationId)).map((entry) => entry.event)).toEqual([
      'PREPARED',
      'SUBMITTED',
      'OPEN_CONFIRMED',
      'CLOSE_PENDING',
      'CLOSED',
    ]);
    expect(await journal.readLatest(mutation.operationId)).toMatchObject({
      reason: 'ENTRY_MUTATION_CONFIRMED',
      metadata: { outcome: { status: 'CONFIRMED', order } },
    });
  });

  it('denies Shared before any exchange calls while startup is closed', async () => {
    const { coordinator } = harness();
    const { service, exchange } = shared(coordinator);
    expect(await service.execute(intent())).toMatchObject({
      status: 'DENIED',
      metadata: { reasonDetail: 'ENTRY_RECOVERY_NOT_INITIALIZED' },
    });
    for (const mock of Object.values(exchange)) expect(mock).not.toHaveBeenCalled();
  });

  it('recovers an ACK lost after receipt using exact lookup, never another send', async () => {
    const { coordinator, lookup } = harness();
    await coordinator.start();
    const { service, exchange } = shared(coordinator);
    exchange.marketOpen.mockImplementation(async () => {
      throw new Error('timeout after server received request');
    });
    lookup.mockResolvedValue(order);
    expect((await service.execute(intent())).status).toBe('OPENED');
    expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOrderId: exchange.marketOpen.mock.calls[0][3],
        kind: 'OPEN',
      }),
    );
  });

  it('restarts an uncertain send on disk and reconciles periodically without resend', async () => {
    const first = harness();
    await first.coordinator.start();
    const send = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await first.coordinator.execute(intent(), 2, 'se_1', send);
    expect(result.status).toBe('UNKNOWN');
    await first.coordinator.close();
    const lookup = vi.fn().mockResolvedValue(null);
    const second = reopen(first.file, lookup);
    await second.coordinator.start();
    expect(second.coordinator.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
    expect(await second.coordinator.execute(intent(), 2, 'se_2', send)).toMatchObject({
      status: 'BLOCKED',
    });
    lookup.mockResolvedValue(order);
    await second.coordinator.reconcile();
    expect(second.coordinator.blockedReason()).toBeUndefined();
    expect(await second.journal.readLatest(result.operationId)).toMatchObject({
      event: 'CLOSED',
      metadata: { outcome: { status: 'CONFIRMED' } },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await second.coordinator.execute(intent(), 2, 'se_1', send)).toMatchObject({
      status: 'BLOCKED',
      reason: 'ENTRY_MUTATION_ALREADY_RECORDED',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never sends a recovered PREPARED, including repeated not-found lookups', async () => {
    const first = harness();
    await seedPrepared(first.journal);
    await first.journal.close();
    const lookup = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('not found'), { code: -2013 }));
    const second = reopen(first.file, lookup);
    await second.coordinator.start();
    await second.coordinator.reconcile();
    const send = vi.fn();
    expect(await second.coordinator.execute(intent(), 2, 'se_new', send)).toMatchObject({
      status: 'BLOCKED',
    });
    expect(send).not.toHaveBeenCalled();
    expect(await second.journal.readLatest('fixture-mutation-operation')).toMatchObject({
      event: 'UNKNOWN',
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('retains confirmed exposure across restart until durable handoff is proved', async () => {
    const first = harness();
    first.confirmHandoff.mockResolvedValue(false);
    await first.coordinator.start();
    const send = vi.fn().mockResolvedValue(order);
    const result = await first.coordinator.execute(intent(), 2, 'se_handoff', send);
    expect(result.status).toBe('CONFIRMED');
    expect(first.coordinator.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
    expect(await first.journal.readLatest(result.operationId)).toMatchObject({
      event: 'OPEN_CONFIRMED',
    });
    await first.coordinator.close();
    const journal = new FileBackedExecutionJournal(first.file);
    const confirmHandoff = vi.fn(async () => false);
    const recovered = new DurableEntryCoordinator({
      scope,
      journal: () => journal,
      lookup: async () => order,
      confirmHandoff,
    });
    coordinators.push(recovered);
    await recovered.start();
    expect(recovered.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
    await recovered.reconcile();
    expect(recovered.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
    expect(send).toHaveBeenCalledTimes(1);
    confirmHandoff.mockResolvedValue(true);
    await recovered.reconcile();
    expect(recovered.blockedReason()).toBeUndefined();
    expect(await journal.readLatest(result.operationId)).toMatchObject({ event: 'CLOSED' });
  });

  it.each(['SUBMITTED', 'OPEN_CONFIRMED', 'CLOSE_PENDING', 'CLOSED'] as JournalEventType[])(
    'holds the reservation if ACK persistence fails at %s, then recovers on restart',
    async (stage) => {
      const first = harness();
      await first.coordinator.start();
      const append = first.journal.append.bind(first.journal);
      vi.spyOn(first.journal, 'append').mockImplementation(async (entry) => {
        if (entry.event === stage) throw new Error('injected disk failure');
        return append(entry);
      });
      const send = vi.fn().mockResolvedValue(order);
      const result = await first.coordinator.execute(intent(), 2, 'se_1', send);
      expect(result).toMatchObject({ status: 'UNKNOWN', reason: 'ENTRY_JOURNAL_UNCERTAIN' });
      expect(await first.coordinator.execute(intent(), 2, 'se_2', send)).toMatchObject({
        status: 'BLOCKED',
      });
      await expect(first.coordinator.close()).rejects.toThrow('ENTRY_JOURNAL_UNCERTAIN');
      const second = reopen(first.file, async () => order);
      await second.coordinator.start();
      expect(await second.journal.readLatest(result.operationId)).toMatchObject({
        event: 'CLOSED',
      });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('retains uncertainty after a real fsync failure even when complete ACK bytes reach disk', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-fsync-'));
    directories.push(directory);
    const file = path.join(directory, 'entries.jsonl');
    let fail = false;
    const io = {
      ...fs,
      fsyncSync: (fd: number) => {
        if (fail) throw new Error('fsync failed');
        fs.fsyncSync(fd);
      },
    };
    const journal = new FileBackedExecutionJournal(file, io);
    const first = harness(journal);
    await first.coordinator.start();
    const send = vi.fn(async () => {
      fail = true;
      return order;
    });
    const result = await first.coordinator.execute(intent(), 2, 'se_sync', send);
    expect(result.status).toBe('UNKNOWN');
    fail = false;
    await expect(first.coordinator.close()).rejects.toThrow();
    const second = reopen(file, async () => order);
    await second.coordinator.start();
    expect(await second.journal.readLatest(result.operationId)).toMatchObject({ event: 'CLOSED' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('permits a newly identified size retry only after durable coded rejection', async () => {
    const { coordinator, journal } = harness();
    await coordinator.start();
    const { service, exchange } = shared(coordinator);
    exchange.marketOpen.mockRejectedValueOnce(
      Object.assign(new Error('coded size rejection'), { code: -2019 }),
    );
    const result = await service.execute(intent());
    expect(result.status).toBe('OPENED');
    expect(exchange.marketOpen).toHaveBeenCalledTimes(2);
    const mutations = result.metadata.entryMutations as Array<{
      operationId: string;
      mutationId: string;
    }>;
    expect(mutations).toHaveLength(2);
    expect(mutations[0].operationId).not.toBe(mutations[1].operationId);
    expect(mutations[0].mutationId).not.toBe(mutations[1].mutationId);
    expect(await journal.readLatest(mutations[0].operationId)).toMatchObject({
      event: 'CLOSED',
      reason: 'ENTRY_MUTATION_REJECTED',
      metadata: { outcome: { status: 'REJECTED', code: -2019 } },
    });
  });

  it('never retries rejection prose without a business code', async () => {
    const { coordinator } = harness();
    await coordinator.start();
    const { service, exchange } = shared(coordinator);
    exchange.marketOpen.mockRejectedValue(new Error('margin is insufficient'));
    expect(await service.execute(intent())).toMatchObject({
      status: 'FAILED',
      reason: 'MARKET_OPEN_AMBIGUOUS',
    });
    expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
    expect(coordinator.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
  });

  it.each([null, undefined, { orderId: '123', avgPrice: 0 }, { orderId: '', avgPrice: 100 }])(
    'treats missing/invalid ACK %j as UNKNOWN',
    async (ack) => {
      const { coordinator } = harness();
      await coordinator.start();
      const send = vi.fn().mockResolvedValue(ack);
      expect(await coordinator.execute(intent(), 2, 'se_1', send)).toMatchObject({
        status: 'UNKNOWN',
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(coordinator.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
    },
  );

  it('blocks identity changes across persistence without sending', async () => {
    const { coordinator, journal } = harness();
    await coordinator.start();
    const value = intent();
    const append = journal.append.bind(journal);
    vi.spyOn(journal, 'append').mockImplementation(async (entry) => {
      const result = await append(entry);
      if (entry.event === 'PREPARED') value.identity.codeCommitSha = 'changed';
      return result;
    });
    const send = vi.fn();
    const result = await coordinator.execute(value, 2, 'se_1', send);
    expect(result).toMatchObject({ status: 'BLOCKED', reason: 'ENTRY_IDENTITY_NOT_CURRENT' });
    expect(send).not.toHaveBeenCalled();
    expect(await journal.readLatest(result.operationId)).toMatchObject({
      event: 'RECOVERY_REQUIRED',
      metadata: { request: { intent: { identity: { codeCommitSha: 'fixture' } } } },
    });
  });

  it('reserves synchronously across competitors and drains the live send before releasing the writer', async () => {
    const { coordinator, file } = harness();
    await coordinator.start();
    let finish!: (value: typeof order) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const send = vi.fn(() => {
      entered();
      return new Promise<typeof order>((resolve) => {
        finish = resolve;
      });
    });
    const first = coordinator.execute(intent(), 2, 'se_1', send);
    const competitor = { ...intent(), tradeId: 'momentum', symbol: 'BTCUSDT' };
    expect(await coordinator.execute(competitor, 2, 'se_2', send)).toMatchObject({
      status: 'BLOCKED',
    });
    await started;
    const closing = coordinator.close();
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    expect(() => new FileBackedExecutionJournal(file)).toThrow('JOURNAL_WRITER_LOCKED');
    expect(await coordinator.execute(intent(), 2, 'se_3', send)).toMatchObject({
      status: 'BLOCKED',
      reason: 'ENTRY_COORDINATOR_STOPPING',
    });
    finish(order);
    expect((await first).status).toBe('CONFIRMED');
    await closing;
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const restarted = reopen(file, async () => null);
    await restarted.coordinator.start();
    expect(restarted.coordinator.blockedReason()).toBeUndefined();
  });

  it('fails startup closed on a persisted account/environment identity mismatch', async () => {
    const { journal } = harness();
    await seedPrepared(journal);
    const coordinator = new DurableEntryCoordinator({
      scope: { ...scope, account: 'another' },
      journal: () => journal,
      lookup: vi.fn(),
      confirmHandoff: async () => false,
    });
    coordinators.push(coordinator);
    await expect(coordinator.start()).rejects.toThrow('ENTRY_RECOVERY_JOURNAL_UNCERTAIN');
    expect(coordinator.blockedReason()).toBe('ENTRY_RECOVERY_JOURNAL_UNCERTAIN');
  });

  it('requires a consistent numeric business code, not conflicting envelopes', () => {
    expect(definiteEntryRejectionCode({ code: -2019 })).toBe(-2019);
    expect(
      definiteEntryRejectionCode({ code: -2019, response: { data: { code: -1007 } } }),
    ).toBeUndefined();
    expect(definiteEntryRejectionCode({ code: '-2019' })).toBeUndefined();
    expect(definiteEntryRejectionCode(new Error('insufficient balance'))).toBeUndefined();
  });
});
