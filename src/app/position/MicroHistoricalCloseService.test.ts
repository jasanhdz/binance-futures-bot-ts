import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import { FsStateStore } from '../../infra/logging/FsStateStore';
import {
  MicroBurstNetLossLedger,
  microBurstLossResetPayload,
  type MicroBurstLossResetCommand,
} from '../../infra/state/MicroBurstNetLossLedger';
import {
  DurableEntryCoordinator,
  type DurableEntryRequest,
} from '../execution/DurableEntryCoordinator';
import { DurableStopCoordinator } from '../execution/DurableStopCoordinator';
import type { TradingExchangePort } from '../ports/Exchange';
import type {
  MicroBurstEconomicIdentity,
  MicroBurstSettlementEvidence,
} from '../../strategies/micro-burst/domain/MicroBurstSettlement';
import { MicroHistoricalCloseService } from './MicroHistoricalCloseService';
import { MicroEntryRecoveryService } from './MicroEntryRecoveryService';

const dirs: string[] = [];
const resources: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const r of resources.splice(0).reverse()) {
    try {
      await r.close();
    } catch {}
  }
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-historical-'));
  dirs.push(dir);
  const opened = Date.UTC(2026, 8, 7, 11);
  const closed = Date.UTC(2026, 8, 7, 12, 51, 1, 51);
  let now = opened + 100;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const scope = { account: 'synthetic', environment: 'SIMULATED' };
  const clientOrderId = `se_${'a'.repeat(33)}`;
  const receipt = { orderId: '101', avgPrice: 0.2189 };
  const intent = {
    identity: {
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: '0.8.0-expected-continuation-live',
      freezeState: 'FROZEN_LIVE',
      strategyHash: `sha256:${'a'.repeat(64)}`,
      configHash: `sha256:${'b'.repeat(64)}`,
      codeCommitSha: 'c'.repeat(40),
    },
    tradeId: 'MICRO-BURST-LEGACY-fixture',
    symbol: 'ADAUSDT',
    side: 'SHORT',
    requestedAt: opened,
    leverage: 20,
    positionFraction: 0.9,
    structuralStopPrice: 0.2201,
    destinationPrice: 0.2162,
    metadata: {},
    protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
  } as unknown as DurableEntryRequest['intent'];
  let entryJournal!: FileBackedExecutionJournal;
  const entryFactory = () =>
    new DurableEntryCoordinator({
      scope,
      journal: () => (entryJournal = new FileBackedExecutionJournal(path.join(dir, 'entry.jsonl'))),
      lookup: async () => receipt,
      confirmHandoff: async () => false,
    });
  let entry = entryFactory();
  resources.push(entry);
  await entry.start();
  const sendEntry = vi.fn(async () => {
    throw new Error('lost ACK');
  });
  const outcome = await entry.execute(intent, 3295, clientOrderId, sendEntry);
  const originalEntry = fs.readFileSync(path.join(dir, 'entry.jsonl'), 'utf8');
  const request = (await entryJournal.readLatest(outcome.operationId))!.metadata!
    .request as DurableEntryRequest;
  expect((await entryJournal.readLatest(outcome.operationId))!.event).toBe('OPEN_CONFIRMED');
  await entry.close();

  const identity: MicroBurstEconomicIdentity = {
    tradeId: intent.tradeId,
    symbol: intent.symbol,
    side: intent.side,
    entryOrderId: receipt.orderId,
    closeOrderIds: ['102'],
    quantity: 3295,
    openedAtMs: opened,
    closedAtMs: closed,
  };
  const evidence: MicroBurstSettlementEvidence = {
    source: 'BINANCE_EXACT_ORDERS_TRADES_AND_INCOME_V1',
    observedAtMs: 0,
    fillsComplete: true,
    fundingComplete: true,
    fundingFromMs: opened,
    fundingThroughMs: closed,
    exactOrdersFilledAndPositionFlat: true,
    funding: [],
    fills: [
      {
        id: '201',
        orderId: '101',
        symbol: 'ADAUSDT',
        side: 'SELL',
        quantity: 3295,
        price: 0.2189,
        eventTimeMs: opened + 50,
        realizedPnlUsdt: 0,
        commission: 0.36063775,
        commissionAsset: 'USDT',
      },
      {
        id: '202',
        orderId: '102',
        symbol: 'ADAUSDT',
        side: 'BUY',
        quantity: 3295,
        price: 0.2233,
        eventTimeMs: closed,
        realizedPnlUsdt: -14.498,
        commission: 0.36788675,
        commissionAsset: 'USDT',
      },
    ],
  };
  const exchange = {
    sendStopCloseOnce: vi.fn(async () => {
      throw Object.assign(new Error('unknown'), { code: -2013 });
    }),
    readStopCloseByClientOrderId: vi.fn(async () => null),
    readStopCloseState: vi.fn(async () => null),
    readActivePosition: vi.fn(async () => ({
      sideMode: 'BOTH',
      qtyAbs: 3295,
      entryPrice: 0.2189,
      leverage: 20,
    })),
    listCloseOrdersForSide: vi.fn(async () => []),
    readHistoricalMicroClose: vi.fn(async () => ({
      identity: structuredClone(identity),
      evidence: { ...structuredClone(evidence), observedAtMs: now },
    })),
    readMicroFlatAndOpenOrders: vi.fn(async () => {
      const startedAtMs = now;
      now += 10;
      return {
        source: 'BINANCE_FRESH_FLAT_AND_ALL_OPEN_ORDERS' as const,
        symbol: 'ADAUSDT',
        startedAtMs,
        observedAtMs: now,
        regularOpenOrders: 0 as const,
        algoOpenOrders: 0 as const,
      };
    }),
    cancelOrderById: vi.fn(),
  };
  let stopJournal!: FileBackedExecutionJournal;
  const stopFactory = () =>
    new DurableStopCoordinator({
      scope,
      journal: () => (stopJournal = new FileBackedExecutionJournal(path.join(dir, 'stop.jsonl'))),
      exchange: exchange as unknown as TradingExchangePort,
    });
  let stops = stopFactory();
  resources.push(stops);
  const stopInput = {
    symbol: 'ADAUSDT',
    side: 'SHORT' as const,
    positionSide: 'BOTH' as const,
    closePosition: true as const,
    workingType: 'MARK_PRICE' as const,
    triggerPrice: 0.2201,
    parentTradeId: intent.tradeId,
    parentOrderId: '101',
    strategyId: 'MICRO_BURST_V1',
    positionQuantity: 3295,
    entryPrice: 0.2189,
  };
  await stops.supervise(stopInput, () => true, true);
  const originalStop = fs.readFileSync(path.join(dir, 'stop.jsonl'), 'utf8');
  await stops.close();
  now = Date.UTC(2026, 8, 10, 21);
  const root = new FsStateStore('default', 'fixture', dir);
  const store = root.forSymbol('ADAUSDT');
  store.set({
    mode: 'IDLE',
    positionOwner: 'BOT',
    tradeOrigin: 'BOT',
    ownershipStatus: 'VERIFIED',
    lastTradeId: intent.tradeId,
    lastOrderId: '101',
    lastStrategy: 'MICRO_BURST_V1' as any,
    lastSide: 'SHORT',
    lastEntryPrice: 0.2189,
    lastEntryQty: 3295,
    lastEntryAt: opened,
    lastExitAt: closed + 500,
    lastExitReason: 'MICRO_FLAT_ACCOUNTING_PENDING',
    marketOpenAmbiguous: true,
    microBurstPnlUnverified: true,
    microBurstPnlUnverifiedAt: closed + 500,
  });
  await store.flush();
  const keys = generateKeyPairSync('ed25519');
  const databasePath = path.join(dir, 'ledger.sqlite');
  const ledgerFactory = () =>
    new MicroBurstNetLossLedger({
      databasePath,
      ...scope,
      operatorPublicKey: keys.publicKey,
      now: () => now,
    });
  let ledger = ledgerFactory();
  resources.push(ledger);
  const command: MicroBurstLossResetCommand = {
    schemaVersion: 1,
    action: 'INITIALIZE',
    ...scope,
    strategyId: 'MICRO_BURST',
    policyVersion: 'MICRO',
    expectedRevision: 0,
    nonce: 'fixture_initialization_nonce',
    issuedAtMs: now,
    expiresAtMs: now + 1000,
    reason: 'Offline fixture only',
  };
  ledger.applyOperatorCommand(
    command,
    sign(null, microBurstLossResetPayload(command), keys.privateKey).toString('base64'),
  );
  stops = stopFactory();
  resources.push(stops);
  await stops.start();
  const serviceFactory = () =>
    new MicroHistoricalCloseService({
      exchange,
      ledger,
      stops,
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      stopping: () => false,
    });
  let service = serviceFactory();
  const recover = vi.fn(async (r: DurableEntryRequest, o: typeof receipt) =>
    service.recover(r, o, store),
  );
  entry = entryFactory();
  resources.push(entry);
  entry.registerPositionRecovery(recover);
  const replay = async () => {
    await entry.close();
    await stops.close();
    ledger.close();
    ledger = ledgerFactory();
    resources.push(ledger);
    stops = stopFactory();
    resources.push(stops);
    await stops.start();
    service = serviceFactory();
    entry = entryFactory();
    resources.push(entry);
    entry.registerPositionRecovery(recover);
    await entry.start();
    return { entry, stops, ledger };
  };
  return {
    dir,
    databasePath,
    store,
    ledger,
    entry,
    stops,
    exchange,
    evidence,
    identity,
    receipt,
    request,
    stopInput,
    originalEntry,
    originalStop,
    recover,
    replay,
    service,
    journals: () => ({ entryJournal, stopJournal }),
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
  };
}

it('settles an OPEN_CONFIRMED legacy entry and UNKNOWN stop, preserves original bytes, and never resends after restart', async () => {
  const f = await fixture();
  await f.entry.start();
  expect(f.entry.blockedReason()).toBeUndefined();
  expect(f.stops.blockedReason()).toBeUndefined();
  const state = new FsStateStore('default', 'fixture', f.dir).forSymbol('ADAUSDT').get();
  expect(state).toMatchObject({
    mode: 'IDLE',
    marketOpenAmbiguous: false,
    microBurstPnlUnverified: false,
    microProtectionBlocked: false,
    microHistoricalClose: { identity: { closedAtMs: f.identity.closedAtMs } },
  });
  expect(state.microHistoricalClose!.identity).not.toHaveProperty('episodeId');
  expect(state.microHistoricalClose!.identity).not.toHaveProperty('policyVersion');
  expect(fs.readFileSync(path.join(f.dir, 'entry.jsonl'), 'utf8').startsWith(f.originalEntry)).toBe(
    true,
  );
  expect(fs.readFileSync(path.join(f.dir, 'stop.jsonl'), 'utf8').startsWith(f.originalStop)).toBe(
    true,
  );
  const retirementId = (await f.journals().stopJournal.listOperations()).find((id) =>
    id.startsWith('stop-retirement:'),
  )!;
  const retirement = (await f.journals().stopJournal.readLatest(retirementId))!.metadata!
    .retirement as any;
  expect(retirement.status).toBe('RETIRED_AFTER_CONFIRMED_FLAT');
  expect(retirement).not.toHaveProperty('orderId');
  expect(f.ledger.snapshot()).toMatchObject({
    consecutiveLosses: 0,
    halted: false,
    pendingSettlements: 0,
  });
  const db = new Database(f.databasePath, { readonly: true });
  expect(db.prepare('SELECT net, closed_at FROM micro_loss_trades').get()).toEqual({
    net: -15.2265245,
    closed_at: f.identity.closedAtMs,
  });
  db.close();
  const revision = f.ledger.snapshot().revision;
  expect(
    f.ledger.observeHistorical(
      state.microHistoricalClose!.identity,
      state.microHistoricalClose!.evidence,
    ),
  ).toMatchObject({ status: 'VERIFIED' });
  expect(f.ledger.snapshot().revision).toBe(revision);
  const restarted = await f.replay();
  expect(restarted.entry.blockedReason()).toBeUndefined();
  expect(restarted.stops.blockedReason()).toBeUndefined();
  expect(f.recover).toHaveBeenCalledTimes(1);
  expect(await restarted.stops.supervise(f.stopInput, () => true, true)).toBe(false);
  expect(restarted.stops.blockedReason()).toBeUndefined();
  expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
  expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
  const recovery = new MicroEntryRecoveryService({
    exchange: {},
    stateForSymbol: () => f.store,
    protection: { superviseMicroStop: vi.fn() },
  });
  expect(await recovery.recover(f.request, f.receipt)).toMatchObject({
    reason: 'RECOVERY_HISTORICAL_CLOSE_REQUIRES_COORDINATOR',
  });
});

it.each([
  'no-fills',
  'partial',
  'fees',
  'funding',
  'foreign-order',
  'new-position',
  'new-owner',
  'stale',
  'backwards',
  'future',
  'alias-bypass',
])('keeps quarantine under %s without sending or declaring cancellation', async (fault) => {
  const f = await fixture();
  if (fault === 'no-fills') f.evidence.fills = [];
  if (fault === 'partial') f.evidence.fills[1].quantity = 3000;
  if (fault === 'fees') f.evidence.fills[0].commission = undefined as any;
  if (fault === 'funding') f.evidence.fundingComplete = false;
  if (fault === 'foreign-order') f.evidence.fills[1].orderId = 'foreign';
  if (fault === 'new-position')
    f.exchange.readMicroFlatAndOpenOrders.mockResolvedValueOnce(null as any);
  if (fault === 'new-owner')
    f.exchange.readMicroFlatAndOpenOrders.mockImplementationOnce(async () => {
      f.store.set({ lastTradeId: 'new-trade' });
      await f.store.flush();
      return null as any;
    });
  if (fault === 'stale')
    f.exchange.readHistoricalMicroClose.mockImplementationOnce(async () => ({
      identity: f.identity,
      evidence: { ...f.evidence, observedAtMs: f.now() - 11_000 },
    }));
  if (fault === 'backwards')
    f.exchange.readHistoricalMicroClose.mockImplementationOnce(async () => {
      f.setNow(f.now() - 1);
      return { identity: f.identity, evidence: { ...f.evidence, observedAtMs: f.now() } };
    });
  if (fault === 'future')
    f.exchange.readHistoricalMicroClose.mockImplementationOnce(async () => ({
      identity: f.identity,
      evidence: { ...f.evidence, observedAtMs: f.now() + 1000 },
    }));
  if (fault === 'alias-bypass') {
    const changed = structuredClone(f.request);
    changed.intent.identity.strategyId = 'MICRO_BURST';
    expect(await f.service.recover(changed, f.receipt, f.store)).toBeUndefined();
    expect(f.exchange.readHistoricalMicroClose).not.toHaveBeenCalled();
    return;
  }
  await f.entry.start();
  expect(f.entry.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
  expect(f.store.get().microBurstPnlUnverified).toBe(true);
  expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
  expect(f.exchange.cancelOrderById).not.toHaveBeenCalled();
  expect(
    (await f.journals().stopJournal.listOperations()).filter((id) =>
      id.startsWith('stop-retirement:'),
    ),
  ).toEqual([]);
});

it('keeps entry admission reserved across final projection flush and rejects a new position after accounting', async () => {
  const f = await fixture();
  const original = f.exchange.readMicroFlatAndOpenOrders.getMockImplementation()!;
  let count = 0;
  f.exchange.readMicroFlatAndOpenOrders.mockImplementation(async () => {
    count++;
    expect(f.entry.blockedReason()).toBeDefined();
    return count === 3 ? (null as any) : original();
  });
  await f.entry.start();
  expect(f.entry.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
  expect(f.store.get().microBurstPnlUnverified).toBe(true);
  const restarted = await f.replay();
  expect(restarted.entry.blockedReason()).toBeUndefined();
  expect(restarted.ledger.snapshot()).toMatchObject({ consecutiveLosses: 0, halted: false });
});

it('does not release entry admission when the final projection flush fails, and recovers without duplicate accounting', async () => {
  const f = await fixture();
  const flush = f.store.flush.bind(f.store);
  let failed = false;
  vi.spyOn(f.store, 'flush').mockImplementation(async () => {
    if (!failed && f.store.get().microBurstPnlUnverified === false) {
      failed = true;
      throw new Error('synthetic fsync failure');
    }
    await flush();
  });
  await f.entry.start();
  expect(failed).toBe(true);
  expect(f.entry.blockedReason()).toBe('ENTRY_MUTATION_PENDING');
  expect(f.store.get()).toMatchObject({
    marketOpenAmbiguous: true,
    microBurstPnlUnverified: true,
    microProtectionBlocked: true,
  });
  await flush();
  const revision = f.ledger.snapshot().revision;
  const restarted = await f.replay();
  expect(restarted.entry.blockedReason()).toBeUndefined();
  expect(restarted.ledger.snapshot().revision).toBe(revision);
  expect(f.exchange.sendStopCloseOnce).toHaveBeenCalledTimes(1);
});

it('does not let a historical close release an unrelated current-day three-loss pause', async () => {
  const f = await fixture();
  for (let index = 1; index <= 3; index++) {
    const openedAtMs = f.now() - 10_000 + index * 100;
    const closedAtMs = openedAtMs + 50;
    const identity = {
      ...f.identity,
      tradeId: `current-${index}`,
      entryOrderId: `current-entry-${index}`,
      closeOrderIds: [`current-close-${index}`],
      openedAtMs,
      closedAtMs,
      episodeId: `episode-${index}`,
      policyVersion: 'MICRO' as const,
      configHash: `sha256:${'a'.repeat(64)}`,
      codeCommitSha: 'b'.repeat(40),
    };
    f.ledger.observe(identity, {
      ...f.evidence,
      observedAtMs: f.now(),
      fundingFromMs: openedAtMs,
      fundingThroughMs: closedAtMs,
      fills: f.evidence.fills.map((fill, leg) => ({
        ...fill,
        id: `current-fill-${index}-${leg}`,
        orderId: leg ? identity.closeOrderIds[0] : identity.entryOrderId,
        eventTimeMs: leg ? closedAtMs : openedAtMs,
      })),
    });
  }
  expect(f.ledger.snapshot()).toMatchObject({ consecutiveLosses: 3, halted: true });
  await f.entry.start();
  expect(f.store.get().microBurstPnlUnverified).toBe(false);
  expect(f.ledger.snapshot()).toMatchObject({
    consecutiveLosses: 3,
    halted: true,
    blockedReason: 'MICRO_THREE_NET_LOSSES_LATCHED',
  });
});
