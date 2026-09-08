import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  MicroBurstNetLossLedger,
  microBurstLossResetPayload,
  type MicroBurstLossResetCommand,
} from './MicroBurstNetLossLedger';
import {
  reconcileMicroBurstSettlement,
  type MicroBurstSettlementEvidence,
  type MicroBurstSettlementIdentity,
} from '../../strategies/micro-burst/domain/MicroBurstSettlement';

const keys = generateKeyPairSync('ed25519');
const now = 100_000;
const dirs: string[] = [];
const ledgers: MicroBurstNetLossLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function settlement(
  index = 1,
  net = -1,
  side: 'LONG' | 'SHORT' = 'LONG',
): {
  identity: MicroBurstSettlementIdentity;
  evidence: MicroBurstSettlementEvidence;
} {
  const identity: MicroBurstSettlementIdentity = {
    tradeId: `MICRO-BURST-V1-${index}`,
    episodeId: `episode-${index}`,
    symbol: 'ETHUSDT',
    side,
    policyVersion: 'CONTEXTUAL_V3',
    configHash: `sha256:${'a'.repeat(64)}`,
    codeCommitSha: 'b'.repeat(40),
    entryOrderId: `entry-${index}`,
    closeOrderIds: [`close-${index}`],
    quantity: 1,
    openedAtMs: index * 100,
    closedAtMs: index * 100 + 50,
  };
  return {
    identity,
    evidence: {
      source: 'BINANCE_EXACT_ORDERS_TRADES_AND_INCOME_V1',
      observedAtMs: now,
      fillsComplete: true,
      fundingComplete: true,
      fundingFromMs: identity.openedAtMs,
      fundingThroughMs: identity.closedAtMs,
      exactOrdersFilledAndPositionFlat: true,
      fills: [
        {
          id: `opening-fill-${index}`,
          orderId: identity.entryOrderId,
          symbol: identity.symbol,
          side: side === 'LONG' ? 'BUY' : 'SELL',
          quantity: 1,
          price: 100,
          eventTimeMs: identity.openedAtMs,
          realizedPnlUsdt: 0,
          commission: 0.1,
          commissionAsset: 'USDT',
        },
        {
          id: `closing-fill-${index}`,
          orderId: identity.closeOrderIds[0],
          symbol: identity.symbol,
          side: side === 'LONG' ? 'SELL' : 'BUY',
          quantity: 1,
          price: 101,
          eventTimeMs: identity.closedAtMs,
          realizedPnlUsdt: net + 0.25,
          commission: 0.1,
          commissionAsset: 'USDT',
        },
      ],
      funding: [
        {
          id: `funding-${index}`,
          tradeId: identity.tradeId,
          symbol: identity.symbol,
          asset: 'USDT',
          amount: -0.05,
          eventTimeMs: identity.openedAtMs + 1,
        },
      ],
    },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'micro-net-loss-'));
  dirs.push(dir);
  const databasePath = join(dir, 'critical.sqlite');
  const options = {
    databasePath,
    account: 'fixture-account',
    environment: 'SIMULATED',
    operatorPublicKey: keys.publicKey,
    now: () => now,
  };
  const reopen = () => {
    const ledger = new MicroBurstNetLossLedger(options);
    ledgers.push(ledger);
    return ledger;
  };
  const ledger = reopen();
  const command = (
    instance = ledger,
    action: MicroBurstLossResetCommand['action'] = 'INITIALIZE',
  ): MicroBurstLossResetCommand => ({
    schemaVersion: 1,
    action,
    account: options.account,
    environment: options.environment,
    strategyId: 'MICRO_BURST_V1',
    policyVersion: 'CONTEXTUAL_V3',
    expectedRevision: instance.snapshot().revision,
    nonce: `operator_nonce_${instance.snapshot().revision}`,
    issuedAtMs: now,
    expiresAtMs: now + 1000,
    reason: 'Explicit synthetic operator checkpoint',
  });
  const apply = (instance: MicroBurstNetLossLedger, value: MicroBurstLossResetCommand) =>
    instance.applyOperatorCommand(
      value,
      sign(null, microBurstLossResetPayload(value), keys.privateKey).toString('base64'),
    );
  return { ledger, reopen, command, apply, options };
}

describe('Micro net settlement economics', () => {
  it.each(['LONG', 'SHORT'] as const)('includes %s opening/closing fees and funding', (side) => {
    const { identity, evidence } = settlement(1, -1, side);
    expect(reconcileMicroBurstSettlement(identity, evidence)).toEqual({
      status: 'VERIFIED',
      grossPnlUsdt: -0.75,
      commissionsUsdt: 0.2,
      fundingUsdt: -0.05,
      netPnlUsdt: -1,
    });
  });
  it.each(['fillsComplete', 'fundingComplete', 'exactOrdersFilledAndPositionFlat'] as const)(
    'does not label missing %s as zero',
    (field) => {
      const { identity, evidence } = settlement();
      evidence[field] = false;
      expect(reconcileMicroBurstSettlement(identity, evidence)).toMatchObject({
        status: 'UNVERIFIED',
        netPnlUsdt: null,
      });
    },
  );
  it.each([
    'missing-open',
    'partial-close',
    'duplicate-fill',
    'foreign-order',
    'unknown-fee',
    'nonfinite',
    'funding-gap',
    'foreign-funding',
    'duplicate-funding',
    'future-fill',
  ])('rejects %s evidence', (fault) => {
    const { identity, evidence } = settlement();
    if (fault === 'missing-open') evidence.fills.shift();
    if (fault === 'partial-close') evidence.fills[1].quantity = 0.5;
    if (fault === 'duplicate-fill') evidence.fills.push(evidence.fills[0]);
    if (fault === 'foreign-order') evidence.fills[1].orderId = 'manual';
    if (fault === 'unknown-fee') evidence.fills[0].commissionAsset = 'BNB';
    if (fault === 'nonfinite') evidence.fills[0].commission = NaN;
    if (fault === 'funding-gap') evidence.fundingThroughMs -= 1;
    if (fault === 'foreign-funding') evidence.funding[0].tradeId = 'manual';
    if (fault === 'duplicate-funding') evidence.funding.push(evidence.funding[0]);
    if (fault === 'future-fill') evidence.fills[1].eventTimeMs += 1;
    expect(reconcileMicroBurstSettlement(identity, evidence)).toMatchObject({
      status: 'UNVERIFIED',
      netPnlUsdt: null,
    });
  });
});

describe('Micro durable three-net-loss latch', () => {
  it('requires signed initialization and cannot use a restart or later win to release a halt', () => {
    const f = fixture();
    expect(f.ledger.snapshot().blockedReason).toBe('MICRO_NET_LOSS_NOT_INITIALIZED');
    f.apply(f.ledger, f.command());
    for (let i = 1; i <= 3; i++) {
      const trade = settlement(i);
      f.ledger.observe(trade.identity, trade.evidence);
    }
    expect(f.ledger.snapshot()).toMatchObject({ consecutiveLosses: 3, halted: true });
    f.ledger.close();
    const restored = f.reopen();
    expect(restored.snapshot().blockedReason).toBe('MICRO_THREE_NET_LOSSES_LATCHED');
    const win = settlement(4, 1);
    restored.observe(win.identity, win.evidence);
    expect(restored.snapshot()).toMatchObject({ consecutiveLosses: 0, halted: true });
    const reset = f.command(restored, 'RESET_LOSS_HALT');
    f.apply(restored, reset);
    expect(restored.snapshot()).toMatchObject({ halted: false, consecutiveLosses: 0, epoch: 2 });
    expect(() => f.apply(restored, reset)).toThrow('STALE_OR_UNSAFE');
  });

  it('counts net losses even when gross PnL is positive, deduplicates, and treats zero as no win', () => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    const trade = settlement(1, -0.125);
    expect(trade.evidence.fills[1].realizedPnlUsdt).toBeGreaterThan(0);
    f.ledger.observe(trade.identity, trade.evidence);
    const revision = f.ledger.snapshot().revision;
    f.ledger.observe(trade.identity, trade.evidence);
    expect(f.ledger.snapshot()).toMatchObject({ consecutiveLosses: 1, revision });
    trade.evidence.observedAtMs -= 1;
    trade.evidence.fills.reverse();
    f.ledger.observe(trade.identity, trade.evidence);
    expect(f.ledger.snapshot()).toMatchObject({
      consecutiveLosses: 1,
      revision,
      pendingSettlements: 0,
    });
    const zero = settlement(2);
    zero.evidence.fills[1].realizedPnlUsdt = 0;
    zero.evidence.fills.forEach((fill) => {
      fill.commission = 0;
    });
    zero.evidence.funding = [];
    f.ledger.observe(zero.identity, zero.evidence);
    expect(f.ledger.snapshot().consecutiveLosses).toBe(1);
    const win = settlement(3, 1);
    f.ledger.observe(win.identity, win.evidence);
    expect(f.ledger.snapshot()).toMatchObject({ consecutiveLosses: 0, halted: false });
  });

  it('persists unknown/nonfinite accounting and blocks reset until evidence is complete', () => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    for (let i = 1; i <= 3; i++) {
      const t = settlement(i);
      f.ledger.observe(t.identity, t.evidence);
    }
    const unknown = settlement(4);
    unknown.evidence.fills[0].commission = NaN;
    expect(f.ledger.observe(unknown.identity, unknown.evidence).netPnlUsdt).toBeNull();
    f.ledger.close();
    const restored = f.reopen();
    expect(restored.snapshot()).toMatchObject({ halted: true, pendingSettlements: 1 });
    expect(() => f.apply(restored, f.command(restored, 'RESET_LOSS_HALT'))).toThrow(
      'STALE_OR_UNSAFE',
    );
    const fixed = settlement(4);
    restored.observe(fixed.identity, fixed.evidence);
    expect(restored.snapshot().pendingSettlements).toBe(0);
    f.apply(restored, f.command(restored, 'RESET_LOSS_HALT'));
  });

  it('replays event-time chronology conservatively and never resets at midnight', () => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    for (const index of [3, 1, 2]) {
      const t = settlement(index);
      f.ledger.observe(t.identity, t.evidence);
    }
    expect(f.ledger.snapshot()).toMatchObject({ consecutiveLosses: 3, halted: true });
    f.ledger.close();
    const nextDay = new MicroBurstNetLossLedger({ ...f.options, now: () => now + 86_400_000 });
    ledgers.push(nextDay);
    expect(nextDay.snapshot()).toMatchObject({ consecutiveLosses: 3, halted: true });
  });

  it.each(['identity', 'cashflows', 'reuse'])('durably quarantines %s conflicts', (fault) => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    const first = settlement(1);
    f.ledger.observe(first.identity, first.evidence);
    const changed = settlement(fault === 'reuse' ? 2 : 1);
    if (fault === 'identity') changed.identity.configHash = `sha256:${'c'.repeat(64)}`;
    if (fault === 'cashflows') changed.evidence.fills[1].commission += 0.01;
    if (fault === 'reuse') changed.evidence.fills[0].id = first.evidence.fills[0].id;
    expect(f.ledger.observe(changed.identity, changed.evidence).netPnlUsdt).toBeNull();
    f.ledger.close();
    expect(f.reopen().snapshot().blockedReason).toBe('MICRO_NET_SETTLEMENT_PENDING');
  });

  it('rejects wrong signatures, scope, stale revision and expired commands', () => {
    const f = fixture();
    expect(() =>
      f.ledger.applyOperatorCommand(f.command(), Buffer.alloc(64).toString('base64')),
    ).toThrow('COMMAND_INVALID');
    for (const override of [
      { account: 'other' },
      { expectedRevision: 9 },
      { issuedAtMs: 0, expiresAtMs: 1 },
    ])
      expect(() => f.apply(f.ledger, { ...f.command(), ...override })).toThrow();
    expect(f.ledger.snapshot().initialized).toBe(false);
  });

  it('pins account, environment and reset key and refuses a missing persisted checkpoint', () => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    f.ledger.close();
    for (const override of [
      { account: 'other' },
      { environment: 'other' },
      { operatorPublicKey: generateKeyPairSync('ed25519').publicKey },
    ])
      expect(() => new MicroBurstNetLossLedger({ ...f.options, ...override })).toThrow(
        'SCOPE_OR_KEY_MISMATCH',
      );
    const db = new Database(f.options.databasePath);
    db.exec('DELETE FROM micro_loss_state');
    db.close();
    expect(() => f.reopen()).toThrow('STATE_MISSING');
  });
});
