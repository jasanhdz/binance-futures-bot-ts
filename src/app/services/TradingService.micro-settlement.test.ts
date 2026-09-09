import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TradingService } from './TradingService';
import { BinanceExchange } from '../../infra/adapters/BinanceAdapter';
import { FsStateStore } from '../../infra/logging/FsStateStore';
import {
  MicroBurstNetLossLedger,
  microBurstLossResetPayload,
  type MicroBurstLossResetCommand,
} from '../../infra/state/MicroBurstNetLossLedger';
import { createMicroBurstTradePolicy } from '../../strategies/micro-burst/domain/MicroBurstTradePolicy';
import type { MicroBurstSettlementIdentity } from '../../strategies/micro-burst/domain/MicroBurstSettlement';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'micro-runtime-settlement-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const options = {
    databasePath: join(dir, 'ledger.sqlite'),
    account: 'simulated',
    environment: 'offline',
    operatorPublicKey: keys.publicKey,
  };
  let ledger = new MicroBurstNetLossLedger(options);
  cleanup.push(() => ledger.close());
  const now = Date.now();
  const command: MicroBurstLossResetCommand = {
    schemaVersion: 1,
    action: 'INITIALIZE',
    account: options.account,
    environment: options.environment,
    strategyId: 'MICRO_BURST',
    policyVersion: 'MICRO',
    expectedRevision: 0,
    nonce: 'synthetic-initialization-nonce',
    issuedAtMs: now,
    expiresAtMs: now + 60_000,
    reason: 'Offline integration fixture',
  };
  ledger.applyOperatorCommand(
    command,
    sign(null, microBurstLossResetPayload(command), keys.privateKey).toString('base64'),
  );
  const policy = createMicroBurstTradePolicy(
    {
      strategyId: 'MICRO_BURST',
      strategyVersion: 'MICRO',
      freezeState: 'DRAFT',
      configHash: `sha256:${'a'.repeat(64)}`,
      codeCommitSha: 'b'.repeat(40),
    },
    {
      sizingMode: 'MARGIN_FRACTION',
      marginFraction: 0.9,
      mediumLeverage: 20,
      highLeverage: 30,
      maxConsecutiveNetLosses: 3,
      resetMode: 'SIGNED_OPERATOR',
      feeReserveBps: 14,
      stopStressBps: 10,
    },
  );
  const store = new FsStateStore('default', 'fixture', dir).forSymbol('ETHUSDT');
  cleanup.push(async () => {
    await store.flush!();
  });
  const exchange = Object.create(BinanceExchange.prototype) as BinanceExchange;
  const read = vi.spyOn(exchange, 'readMicroBurstSettlement');
  const client = {
    futuresTime: vi.fn(async () => Date.now()),
    futuresUserTrades: vi.fn<() => Promise<Record<string, unknown>[]>>(),
    futuresIncome: vi.fn(async () => []),
    futuresGetOrder: vi.fn(async ({ orderId }: { orderId: number }) => ({
      orderId,
      symbol: 'ETHUSDT',
      positionSide: 'BOTH',
      status: 'FILLED',
      origQty: '1',
      executedQty: '1',
      side: String(orderId) === store.get().microBurstSettlement!.entryOrderId ? 'BUY' : 'SELL',
    })),
    futuresPositionRisk: vi.fn(async () => [
      { symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '0' },
    ]),
  };
  Object.assign(exchange, { cli: client, enqueue: async (work: () => Promise<unknown>) => work() });
  const service = Object.create(TradingService.prototype) as any;
  Object.assign(service, {
    activeRuntimeTasks: new Set(),
    symbolStateStores: new Map([['ETHUSDT', store]]),
    deps: { microNetLossLedger: ledger, exchange, logger: { info: vi.fn(), error: vi.fn() } },
  });
  const prepare = async (index: number, net = -1) => {
    const openedAtMs = now - 10_000 + index * 100;
    const identity: MicroBurstSettlementIdentity = {
      tradeId: `trade-${index}`,
      episodeId: `episode-${index}`,
      symbol: 'ETHUSDT',
      side: 'LONG',
      policyVersion: 'MICRO',
      configHash: policy.sourceConfigHash,
      codeCommitSha: policy.sourceCodeCommitSha,
      entryOrderId: String(index * 2),
      closeOrderIds: [String(index * 2 + 1)],
      quantity: 1,
      openedAtMs,
      closedAtMs: openedAtMs + 50,
    };
    store.set({
      mode: 'IDLE',
      positionOwner: 'BOT',
      lastStrategy: 'MICRO_BURST',
      lastStrategyVersion: 'MICRO',
      lastTradeId: identity.tradeId,
      lastOrderId: identity.entryOrderId,
      lastSide: 'LONG',
      lastEntryQty: 1,
      lastEntryAt: openedAtMs + 10,
      microBurstEntrySubmittedAtMs: openedAtMs,
      lastConfigHash: identity.configHash,
      lastCodeCommitSha: identity.codeCommitSha,
      microBurstEpisodeId: identity.episodeId,
      microBurstTradePolicy: policy,
      microBurstSettlement: identity,
      microBurstPnlUnverified: true,
      microBurstPnlUnverifiedAt: now,
    });
    await store.flush!();
    client.futuresUserTrades.mockResolvedValue(
      [identity.entryOrderId, identity.closeOrderIds[0]].map((orderId, i) => ({
        id: Number(orderId),
        orderId: Number(orderId),
        symbol: identity.symbol,
        positionSide: 'BOTH',
        side: i === 0 ? 'BUY' : 'SELL',
        qty: '1',
        price: '100',
        realizedPnl: String(i === 0 ? 0 : net + 0.25),
        commission: '0.125',
        commissionAsset: 'USDT',
        time: openedAtMs + (i === 0 ? 10 : 40),
      })),
    );
  };
  const reopen = () => {
    ledger.close();
    ledger = new MicroBurstNetLossLedger(options);
    service.deps.microNetLossLedger = ledger;
    return ledger;
  };
  return { service, store, client, read, prepare, reopen, ledger: () => ledger };
}

describe('TradingService -> Binance accounting -> durable net-loss ledger', () => {
  it('latches three exact net losses, survives restart and cannot be released by a later win', async () => {
    const f = fixture();
    for (let i = 1; i <= 3; i++) {
      await f.prepare(i);
      await f.service.reconcileMicroNetSettlements();
      expect(f.store.get().microBurstPnlUnverified).toBe(false);
      expect(f.ledger().snapshot().consecutiveLosses).toBe(i);
      if (i === 2) f.reopen();
    }
    expect(f.service.microNetLossBlockedReason()).toBe('MICRO_THREE_NET_LOSSES_LATCHED');
    f.reopen();
    await f.prepare(4, 1);
    await f.service.reconcileMicroNetSettlements();
    expect(f.service.microNetLossBlockedReason()).toBe('MICRO_THREE_NET_LOSSES_LATCHED');
    expect(f.ledger().snapshot().pendingSettlements).toBe(0);
  });

  it('does not count an exact tie as a win and resets the pre-halt streak only for a net win', async () => {
    const f = fixture();
    for (const [index, net, expected] of [
      [1, -1, 1],
      [2, 0, 1],
      [3, 1, 0],
    ]) {
      await f.prepare(index, net);
      await f.service.reconcileMicroNetSettlements();
      expect(f.ledger().snapshot().consecutiveLosses).toBe(expected);
    }
  });

  it('persists pending before the exchange read, retries reads only and deduplicates settlement', async () => {
    const f = fixture();
    await f.prepare(1);
    f.read.mockImplementationOnce(async () => {
      expect(f.ledger().snapshot().pendingSettlements).toBe(1);
      throw new Error('funding unavailable');
    });
    await f.service.reconcileMicroNetSettlements();
    expect(f.service.microNetLossBlockedReason()).toBe('MICRO_NET_SETTLEMENT_PENDING');
    expect(f.store.get().microBurstPnlUnverified).toBe(true);
    f.reopen();
    await f.service.reconcileMicroNetSettlements();
    expect(f.ledger().snapshot().consecutiveLosses).toBe(1);
    f.store.set({ microBurstPnlUnverified: true });
    await f.service.reconcileMicroNetSettlements();
    expect(f.ledger().snapshot().consecutiveLosses).toBe(1);
  });

  it.each(['missing-policy', 'legacy', 'foreign-owner', 'missing-identity'])(
    'preserves %s quarantine without adopting it',
    async (reason) => {
      const f = fixture();
      await f.prepare(1);
      f.store.set(
        reason === 'missing-policy'
          ? { microBurstTradePolicy: undefined }
          : reason === 'legacy'
            ? { lastStrategyVersion: 'REACTION' }
            : reason === 'foreign-owner'
              ? { positionOwner: 'EXTERNAL' }
              : { microBurstSettlement: undefined },
      );
      await f.service.reconcileMicroNetSettlements();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.store.get().microBurstPnlUnverified).toBe(true);
    },
  );

  it('restores in-memory quarantine when the accounting-clear flush fails', async () => {
    const f = fixture();
    await f.prepare(1);
    vi.spyOn(f.store, 'flush').mockRejectedValueOnce(new Error('disk failure'));
    await f.service.reconcileMicroNetSettlements();
    expect(f.store.get().microBurstPnlUnverified).toBe(true);
    await f.service.reconcileMicroNetSettlements();
    expect(f.store.get().microBurstPnlUnverified).toBe(false);
    expect(f.ledger().snapshot().consecutiveLosses).toBe(1);
  });

  it('keeps shared admission blocked until the quarantine-clear flush completes', async () => {
    const f = fixture();
    await f.prepare(1);
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(f.store, 'flush').mockImplementationOnce(async () => {
      await wait;
    });
    const task = f.service.reconcileMicroNetSettlements();
    expect(f.service.reconcileMicroNetSettlements()).toBe(task);
    await vi.waitFor(() => expect(f.store.get().microBurstPnlUnverified).toBe(false));
    expect(f.service.hasPendingMicroSafety()).toBe(true);
    expect(f.service.microNetLossBlockedReason()).toBe('MICRO_NET_SETTLEMENT_RECONCILING');
    finish();
    await task;
    expect(f.service.hasPendingMicroSafety()).toBe(false);
  });
});
