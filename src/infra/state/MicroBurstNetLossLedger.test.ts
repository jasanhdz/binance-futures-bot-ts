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
    tradeId: `MICRO-BURST-${index}`,
    episodeId: `episode-${index}`,
    symbol: 'ETHUSDT',
    side,
    policyVersion: 'MICRO',
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
    strategyId: 'MICRO_BURST',
    policyVersion: 'MICRO',
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
  it.each([0, 3])(
    'opens the persisted legacy identity without resetting revision, signed commands or %s losses',
    (losses) => {
      const f = fixture();
      f.apply(f.ledger, f.command());
      for (let i = 1; i <= losses; i++) {
        const trade = settlement(i);
        f.ledger.observe(trade.identity, trade.evidence);
      }
      const before = f.ledger.snapshot();
      f.ledger.close();
      const db = new Database(f.options.databasePath);
      const identity = JSON.parse(
        (
          db.prepare('SELECT identity FROM micro_loss_meta WHERE id = 1').get() as {
            identity: string;
          }
        ).identity,
      );
      identity[3] = 'MICRO_BURST_V1';
      identity[4] = 'CONTEXTUAL_V3';
      const legacy = JSON.stringify(identity);
      db.prepare('UPDATE micro_loss_meta SET identity = ? WHERE id = 1').run(legacy);
      const commands = db.prepare('SELECT * FROM micro_loss_commands').all();
      db.close();
      const restored = f.reopen();
      expect(restored.snapshot()).toEqual(before);
      if (losses === 3)
        expect(restored.snapshot().blockedReason).toBe('MICRO_THREE_NET_LOSSES_LATCHED');
      restored.close();
      const observed = new Database(f.options.databasePath, { readonly: true });
      expect(observed.prepare('SELECT identity FROM micro_loss_meta WHERE id = 1').get()).toEqual({
        identity: legacy,
      });
      expect(observed.prepare('SELECT * FROM micro_loss_commands').all()).toEqual(commands);
      observed.close();
      expect(
        () =>
          new MicroBurstNetLossLedger({
            ...f.options,
            operatorPublicKey: generateKeyPairSync('ed25519').publicKey,
          }),
      ).toThrow('SCOPE_OR_KEY_MISMATCH');
    },
  );
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

  it('replays event-time chronology and releases only the loss pause at midnight', () => {
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
    expect(nextDay.snapshot()).toMatchObject({ consecutiveLosses: 0, halted: false });
  });

  it('carries pending evidence across midnight and attributes late confirmation to the close day', () => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    const pending = settlement(1);
    f.ledger.observe(pending.identity);
    f.ledger.close();
    const nextDay = new MicroBurstNetLossLedger({ ...f.options, now: () => now + 86_400_000 });
    ledgers.push(nextDay);
    expect(nextDay.snapshot()).toMatchObject({
      consecutiveLosses: 0,
      halted: false,
      pendingSettlements: 1,
      blockedReason: 'MICRO_NET_SETTLEMENT_PENDING',
    });
    nextDay.observe(pending.identity, pending.evidence);
    expect(nextDay.snapshot()).toMatchObject({
      consecutiveLosses: 0,
      pendingSettlements: 0,
      blockedReason: null,
    });
    nextDay.close();
    const rollback = f.reopen();
    expect(rollback.snapshot().blockedReason).toBe('MICRO_NET_LOSS_CLOCK_INVALID');
  });

  it('does not let a late previous-day settlement release the current-day pause', () => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    f.ledger.close();
    const nextDay = new MicroBurstNetLossLedger({ ...f.options, now: () => now + 86_400_000 });
    ledgers.push(nextDay);
    for (let index = 1; index <= 3; index++) {
      const t = settlement(index);
      t.identity.openedAtMs += 86_400_000;
      t.identity.closedAtMs += 86_400_000;
      t.evidence.observedAtMs += 86_400_000;
      t.evidence.fundingFromMs += 86_400_000;
      t.evidence.fundingThroughMs += 86_400_000;
      for (const fill of t.evidence.fills) fill.eventTimeMs += 86_400_000;
      for (const funding of t.evidence.funding) funding.eventTimeMs += 86_400_000;
      nextDay.observe(t.identity, t.evidence);
    }
    const oldWin = settlement(4, 1);
    nextDay.observe(oldWin.identity, oldWin.evidence);
    expect(nextDay.snapshot()).toMatchObject({ consecutiveLosses: 3, halted: true });
  });

  it('uses the final closing fill date, not the later local flat-observation date', () => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    f.ledger.close();
    const nextDay = new MicroBurstNetLossLedger({ ...f.options, now: () => now + 86_400_000 });
    ledgers.push(nextDay);
    const old = settlement(1);
    old.identity.closedAtMs += 86_400_000;
    old.evidence.observedAtMs += 86_400_000;
    old.evidence.fundingThroughMs = old.identity.closedAtMs;
    nextDay.observe(old.identity, old.evidence);
    expect(nextDay.snapshot()).toMatchObject({ consecutiveLosses: 0, pendingSettlements: 0 });
  });

  it('migrates an existing calendarless ledger without rewriting signed history or clearing pending evidence', () => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    for (let i = 1; i <= 3; i++) {
      const t = settlement(i);
      f.ledger.observe(t.identity, t.evidence);
    }
    const unknown = settlement(4);
    f.ledger.observe(unknown.identity);
    const before = f.ledger.snapshot();
    f.ledger.close();
    const db = new Database(f.options.databasePath);
    db.exec('DROP TABLE micro_loss_calendar; DROP TABLE micro_loss_rollovers');
    const commands = db.prepare('SELECT * FROM micro_loss_commands').all();
    const trades = db.prepare('SELECT * FROM micro_loss_trades').all();
    db.close();
    const migrated = new MicroBurstNetLossLedger({ ...f.options, now: () => now + 86_400_000 });
    ledgers.push(migrated);
    expect(migrated.snapshot()).toMatchObject({
      revision: before.revision + 1,
      epoch: before.epoch,
      halted: false,
      consecutiveLosses: 0,
      pendingSettlements: 1,
      blockedReason: 'MICRO_NET_SETTLEMENT_PENDING',
    });
    migrated.close();
    const audit = new Database(f.options.databasePath, { readonly: true });
    expect(audit.prepare('SELECT * FROM micro_loss_commands').all()).toEqual(commands);
    expect(audit.prepare('SELECT * FROM micro_loss_trades').all()).toEqual(trades);
    expect(audit.prepare('SELECT * FROM micro_loss_rollovers').all()).toHaveLength(1);
    audit.close();
  });

  it('rolls over within a running process at exactly 00:00 UTC without initializing a missing ledger', () => {
    const f = fixture();
    f.apply(f.ledger, f.command());
    for (let i = 1; i <= 3; i++) {
      const t = settlement(i);
      f.ledger.observe(t.identity, t.evidence);
    }
    f.ledger.close();
    let clock = 86_400_000 - 1;
    const running = new MicroBurstNetLossLedger({ ...f.options, now: () => clock });
    ledgers.push(running);
    expect(running.snapshot().halted).toBe(true);
    clock++;
    expect(running.snapshot()).toMatchObject({ halted: false, consecutiveLosses: 0, epoch: 1 });
    running.close();
    const restored = new MicroBurstNetLossLedger({ ...f.options, now: () => clock });
    ledgers.push(restored);
    expect(restored.snapshot().blockedReason).toBeNull();
    const missing = fixture();
    missing.ledger.close();
    const empty = new MicroBurstNetLossLedger({ ...missing.options, now: () => clock });
    ledgers.push(empty);
    expect(empty.snapshot().blockedReason).toBe('MICRO_NET_LOSS_NOT_INITIALIZED');
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
