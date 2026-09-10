import Database from 'better-sqlite3';
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  reconcileMicroBurstSettlement,
  validMicroBurstSettlementIdentity,
  type MicroBurstSettlementEvidence,
  type MicroBurstSettlementIdentity,
  type MicroBurstSettlementResult,
} from '../../strategies/micro-burst/domain/MicroBurstSettlement';

export interface MicroBurstLossResetCommand {
  schemaVersion: 1;
  action: 'INITIALIZE' | 'RESET_LOSS_HALT';
  account: string;
  environment: string;
  strategyId: 'MICRO_BURST';
  policyVersion: 'MICRO';
  expectedRevision: number;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  reason: string;
}

/** Exact domain-separated bytes signed by an external operator, never by the bot. */
export function microBurstLossResetPayload(command: MicroBurstLossResetCommand): Buffer {
  return Buffer.from(
    JSON.stringify([
      'MICRO_NET_LOSS_OPERATOR_COMMAND_V1',
      command.schemaVersion,
      command.action,
      command.account,
      command.environment,
      command.strategyId,
      command.policyVersion,
      command.expectedRevision,
      command.nonce,
      command.issuedAtMs,
      command.expiresAtMs,
      command.reason,
    ]),
  );
}

export interface MicroBurstNetLossSnapshot {
  initialized: boolean;
  revision: number;
  epoch: number;
  consecutiveLosses: number;
  halted: boolean;
  pendingSettlements: number;
  blockedReason: string | null;
}

interface StateRow {
  initialized: number;
  revision: number;
  epoch: number;
  streak: number;
  halted: number;
}

/** Account/environment-specific critical storage; UTC rollover never clears settlement evidence. */
export class MicroBurstNetLossLedger {
  private readonly db: Database.Database;
  private readonly publicKey: KeyObject;
  private failure: string | null = null;
  private readonly scope: { account: string; environment: string };
  private readonly now: () => number;
  private lastClock = 0;

  constructor(options: {
    databasePath: string;
    account: string;
    environment: string;
    operatorPublicKey: string | KeyObject;
    now?: () => number;
  }) {
    this.scope = { account: options.account, environment: options.environment };
    this.now = options.now ?? Date.now;
    if (!Object.values(this.scope).every((v) => typeof v === 'string' && !!v.trim()))
      throw new Error('MICRO_NET_LOSS_SCOPE_REQUIRED');
    this.publicKey =
      typeof options.operatorPublicKey === 'string'
        ? createPublicKey(options.operatorPublicKey)
        : options.operatorPublicKey;
    if (this.publicKey.type !== 'public' || this.publicKey.asymmetricKeyType !== 'ed25519')
      throw new Error('MICRO_NET_LOSS_OPERATOR_KEY_INVALID');
    this.db = new Database(options.databasePath, { timeout: 5000 });
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      if (this.db.pragma('quick_check', { simple: true }) !== 'ok')
        throw new Error('MICRO_NET_LOSS_DATABASE_INVALID');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS micro_loss_meta (id INTEGER PRIMARY KEY CHECK(id = 1), identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS micro_loss_state (
          id INTEGER PRIMARY KEY CHECK(id = 1), initialized INTEGER NOT NULL CHECK(initialized IN (0,1)),
          revision INTEGER NOT NULL CHECK(revision >= 0), epoch INTEGER NOT NULL CHECK(epoch >= 0),
          streak INTEGER NOT NULL CHECK(streak >= 0), halted INTEGER NOT NULL CHECK(halted IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS micro_loss_trades (
          trade_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, closed_at INTEGER NOT NULL,
          identity TEXT NOT NULL, evidence TEXT, result TEXT, net REAL,
          conflicted INTEGER NOT NULL DEFAULT 0 CHECK(conflicted IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS micro_loss_refs (
          ref TEXT PRIMARY KEY, trade_id TEXT NOT NULL REFERENCES micro_loss_trades(trade_id)
        );
        CREATE TABLE IF NOT EXISTS micro_loss_commands (
          nonce TEXT PRIMARY KEY, command TEXT NOT NULL, signature TEXT NOT NULL, applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS micro_loss_calendar (
          id INTEGER PRIMARY KEY CHECK(id = 1), day_start INTEGER NOT NULL, last_seen INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS micro_loss_rollovers (
          revision INTEGER PRIMARY KEY, from_day INTEGER, to_day INTEGER NOT NULL, observed_at INTEGER NOT NULL
        );
      `);
      const identity = JSON.stringify([
        1,
        this.scope.account,
        this.scope.environment,
        'MICRO_BURST',
        'MICRO',
        3,
        createHash('sha256')
          .update(this.publicKey.export({ type: 'spki', format: 'der' }))
          .digest('hex'),
      ]);
      this.db
        .transaction(() => {
          const existed = this.db.prepare('SELECT 1 FROM micro_loss_meta WHERE id = 1').get();
          this.db.prepare('INSERT OR IGNORE INTO micro_loss_meta VALUES (1, ?)').run(identity);
          const saved = this.db
            .prepare('SELECT identity FROM micro_loss_meta WHERE id = 1')
            .get() as { identity: string };
          const legacyIdentity = JSON.parse(identity) as unknown[];
          legacyIdentity[3] = 'MICRO_BURST_V1';
          legacyIdentity[4] = 'CONTEXTUAL_V3';
          if (saved.identity !== identity && saved.identity !== JSON.stringify(legacyIdentity))
            throw new Error('MICRO_NET_LOSS_SCOPE_OR_KEY_MISMATCH');
          if (existed && !this.db.prepare('SELECT 1 FROM micro_loss_state WHERE id = 1').get())
            throw new Error('MICRO_NET_LOSS_STATE_MISSING');
          this.db.prepare('INSERT OR IGNORE INTO micro_loss_state VALUES (1, 0, 0, 0, 0, 0)').run();
        })
        .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  snapshot(): MicroBurstNetLossSnapshot {
    try {
      this.db.transaction(() => this.syncUtcDay()).immediate();
      const state = this.db
        .prepare('SELECT * FROM micro_loss_state WHERE id = 1')
        .get() as StateRow;
      const { count } = this.db
        .prepare(
          'SELECT count(*) AS count FROM micro_loss_trades WHERE net IS NULL OR conflicted = 1',
        )
        .get() as { count: number };
      return {
        initialized: state.initialized === 1,
        revision: state.revision,
        epoch: state.epoch,
        consecutiveLosses: state.streak,
        halted: state.halted === 1,
        pendingSettlements: count,
        blockedReason:
          this.failure ??
          (!state.initialized
            ? 'MICRO_NET_LOSS_NOT_INITIALIZED'
            : state.halted
              ? 'MICRO_THREE_NET_LOSSES_LATCHED'
              : count
                ? 'MICRO_NET_SETTLEMENT_PENDING'
                : null),
      };
    } catch (error) {
      const clockUnavailable =
        error instanceof Error && error.message === 'MICRO_NET_LOSS_CLOCK_UNAVAILABLE';
      if (!clockUnavailable)
        this.failure ??=
          error instanceof Error && error.message === 'MICRO_NET_LOSS_CLOCK_INVALID'
            ? 'MICRO_NET_LOSS_CLOCK_INVALID'
            : 'MICRO_NET_LOSS_STORAGE_UNAVAILABLE';
      return {
        initialized: false,
        revision: 0,
        epoch: 0,
        consecutiveLosses: 0,
        halted: true,
        pendingSettlements: 0,
        blockedReason: this.failure ?? 'MICRO_NET_LOSS_CLOCK_UNAVAILABLE',
      };
    }
  }

  /** Missing evidence is a durable pending close, never a zero-PnL observation. */
  observe(
    identity: MicroBurstSettlementIdentity,
    evidence?: MicroBurstSettlementEvidence,
  ): MicroBurstSettlementResult {
    if (this.failure) throw new Error(this.failure);
    const now = this.now();
    if (!validMicroBurstSettlementIdentity(identity) || identity.closedAtMs > now)
      throw new Error('MICRO_SETTLEMENT_IDENTITY_INVALID');
    const result: MicroBurstSettlementResult = evidence
      ? reconcileMicroBurstSettlement(identity, evidence)
      : { status: 'UNVERIFIED', netPnlUsdt: null, reason: 'MICRO_SETTLEMENT_EVIDENCE_MISSING' };
    if (evidence && evidence.observedAtMs > now)
      throw new Error('MICRO_SETTLEMENT_FUTURE_EVIDENCE');
    const identityJson = canonical(identity);
    let evidenceJson: string | null = null;
    try {
      evidenceJson = evidence ? canonical(evidence) : null;
      if (evidenceJson && Buffer.byteLength(evidenceJson) > 1_048_576)
        throw new Error('MICRO_SETTLEMENT_EVIDENCE_TOO_LARGE');
    } catch {
      if (result.status === 'VERIFIED') throw new Error('MICRO_SETTLEMENT_NON_JSON_EVIDENCE');
      evidenceJson = null;
      // Invalid numeric evidence remains pending; never coerce NaN to a zero cashflow.
    }
    try {
      return this.db
        .transaction((): MicroBurstSettlementResult => {
          this.syncUtcDay(now, true);
          const state = this.db
            .prepare('SELECT * FROM micro_loss_state WHERE id = 1')
            .get() as StateRow;
          if (!state.initialized) throw new Error('MICRO_NET_LOSS_NOT_INITIALIZED');
          const previous = this.db
            .prepare('SELECT * FROM micro_loss_trades WHERE trade_id = ?')
            .get(identity.tradeId) as
            | { identity: string; evidence: string | null; net: number | null; conflicted: number }
            | undefined;
          const refs =
            evidence && result.status === 'VERIFIED'
              ? [
                  ...evidence.fills.map((fill) => `fill:${identity.symbol}:${fill.id}`),
                  ...evidence.funding.map((funding) => `funding:${funding.id}`),
                ]
              : [];
          const reused = refs.some((ref) => {
            const owner = this.db
              .prepare('SELECT trade_id FROM micro_loss_refs WHERE ref = ?')
              .get(ref) as { trade_id: string } | undefined;
            return owner && owner.trade_id !== identity.tradeId;
          });
          if (!previous) {
            const { count } = this.db
              .prepare('SELECT count(*) AS count FROM micro_loss_trades')
              .get() as { count: number };
            if (count >= 100_000) throw new Error('MICRO_NET_LOSS_CAPACITY_REACHED');
            this.db
              .prepare(
                'INSERT INTO micro_loss_trades (trade_id, epoch, closed_at, identity) VALUES (?, ?, ?, ?)',
              )
              .run(identity.tradeId, state.epoch, identity.closedAtMs, identityJson);
          }
          if (
            reused ||
            previous?.conflicted ||
            (previous && previous.identity !== identityJson) ||
            (previous?.net !== null &&
              previous?.net !== undefined &&
              result.status === 'VERIFIED' &&
              cashflows(JSON.parse(previous.evidence!)) !== cashflows(evidence!))
          ) {
            this.db
              .prepare('UPDATE micro_loss_trades SET conflicted = 1 WHERE trade_id = ?')
              .run(identity.tradeId);
            this.db
              .prepare('UPDATE micro_loss_state SET revision = revision + 1 WHERE id = 1')
              .run();
            return { status: 'UNVERIFIED', netPnlUsdt: null, reason: 'MICRO_SETTLEMENT_CONFLICT' };
          }
          if (previous?.net !== null && previous?.net !== undefined)
            return JSON.parse(
              (
                this.db
                  .prepare('SELECT result FROM micro_loss_trades WHERE trade_id = ?')
                  .get(identity.tradeId) as { result: string }
              ).result,
            ) as MicroBurstSettlementResult;
          if (result.status === 'VERIFIED') {
            this.db
              .prepare(
                'UPDATE micro_loss_trades SET evidence = ?, result = ?, net = ?, closed_at = ? WHERE trade_id = ?',
              )
              .run(
                evidenceJson,
                canonical(result),
                result.netPnlUsdt,
                Math.max(
                  ...evidence!.fills
                    .filter((fill) => fill.orderId !== identity.entryOrderId)
                    .map((fill) => fill.eventTimeMs),
                ),
                identity.tradeId,
              );
            for (const ref of refs)
              this.db
                .prepare('INSERT INTO micro_loss_refs VALUES (?, ?)')
                .run(ref, identity.tradeId);
          } else {
            this.db
              .prepare('UPDATE micro_loss_trades SET evidence = ?, result = ? WHERE trade_id = ?')
              .run(evidenceJson, canonical(result), identity.tradeId);
          }
          const outcomes = this.db
            .prepare(
              'SELECT net FROM micro_loss_trades WHERE epoch = ? AND net IS NOT NULL AND closed_at >= ? AND closed_at < ? ORDER BY closed_at, trade_id',
            )
            .all(
              state.epoch,
              Math.floor(now / 86_400_000) * 86_400_000,
              (Math.floor(now / 86_400_000) + 1) * 86_400_000,
            ) as { net: number }[];
          let streak = 0;
          let halted = state.halted;
          for (const outcome of outcomes) {
            if (outcome.net < 0) streak += 1;
            else if (outcome.net > 0) streak = 0;
            // A later win or corrected chronology cannot release an already observed halt.
            if (streak >= 3) halted = 1;
          }
          this.db
            .prepare(
              'UPDATE micro_loss_state SET revision = revision + 1, streak = ?, halted = ? WHERE id = 1',
            )
            .run(streak, halted);
          return result;
        })
        .immediate();
    } catch (error) {
      this.failure = 'MICRO_NET_LOSS_STORAGE_OR_CONTRACT_FAILED';
      throw error;
    }
  }

  applyOperatorCommand(command: MicroBurstLossResetCommand, signature: string): void {
    if (this.failure) throw new Error(this.failure);
    const now = this.now();
    if (
      command.schemaVersion !== 1 ||
      !['INITIALIZE', 'RESET_LOSS_HALT'].includes(command.action) ||
      command.account !== this.scope.account ||
      command.environment !== this.scope.environment ||
      command.strategyId !== 'MICRO_BURST' ||
      command.policyVersion !== 'MICRO' ||
      !Number.isSafeInteger(command.expectedRevision) ||
      command.expectedRevision < 0 ||
      typeof command.nonce !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(command.nonce) ||
      typeof command.reason !== 'string' ||
      !command.reason.trim() ||
      command.reason.length > 1000 ||
      !Number.isSafeInteger(command.issuedAtMs) ||
      !Number.isSafeInteger(command.expiresAtMs) ||
      command.issuedAtMs < 0 ||
      command.issuedAtMs > now ||
      command.expiresAtMs < now ||
      command.expiresAtMs <= command.issuedAtMs ||
      command.expiresAtMs - command.issuedAtMs > 300_000 ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
      !verify(
        null,
        microBurstLossResetPayload(command),
        this.publicKey,
        Buffer.from(signature, 'base64'),
      )
    )
      throw new Error('MICRO_NET_LOSS_OPERATOR_COMMAND_INVALID');
    this.db
      .transaction(() => {
        const state = this.snapshot();
        if (
          state.revision !== command.expectedRevision ||
          state.pendingSettlements !== 0 ||
          (command.action === 'INITIALIZE'
            ? state.initialized
            : !state.initialized || !state.halted) ||
          this.db.prepare('SELECT 1 FROM micro_loss_commands WHERE nonce = ?').get(command.nonce)
        )
          throw new Error('MICRO_NET_LOSS_OPERATOR_COMMAND_STALE_OR_UNSAFE');
        this.db
          .prepare('INSERT INTO micro_loss_commands VALUES (?, ?, ?, ?)')
          .run(command.nonce, canonical(command), signature, now);
        this.db
          .prepare(
            'UPDATE micro_loss_state SET initialized = 1, revision = revision + 1, epoch = epoch + 1, streak = 0, halted = 0 WHERE id = 1',
          )
          .run();
      })
      .immediate();
  }

  close(): void {
    this.db.close();
  }

  private syncUtcDay(now = this.now(), persistClock = false): void {
    const calendar = this.db.prepare('SELECT * FROM micro_loss_calendar WHERE id = 1').get() as
      | { day_start: number; last_seen: number }
      | undefined;
    if (
      !Number.isSafeInteger(now) ||
      now < this.lastClock ||
      (calendar && now < calendar.last_seen)
    ) {
      this.failure = 'MICRO_NET_LOSS_CLOCK_INVALID';
      throw new Error(this.failure);
    }
    this.lastClock = now;
    const day = Math.floor(now / 86_400_000) * 86_400_000;
    if (!calendar || calendar.day_start !== day) {
      if (!calendar) {
        const historical = this.db
          .prepare(
            'SELECT trade_id, identity, evidence FROM micro_loss_trades WHERE net IS NOT NULL',
          )
          .all() as { trade_id: string; identity: string; evidence: string }[];
        for (const trade of historical) {
          const identity = JSON.parse(trade.identity) as MicroBurstSettlementIdentity;
          const evidence = JSON.parse(trade.evidence) as MicroBurstSettlementEvidence;
          const result = reconcileMicroBurstSettlement(identity, evidence);
          if (result.status !== 'VERIFIED') throw new Error('MICRO_NET_LOSS_HISTORY_INVALID');
          const closedAt = Math.max(
            ...evidence.fills
              .filter((fill) => fill.orderId !== identity.entryOrderId)
              .map((fill) => fill.eventTimeMs),
          );
          this.db
            .prepare('UPDATE micro_loss_trades SET closed_at = ? WHERE trade_id = ?')
            .run(closedAt, trade.trade_id);
        }
      }
      const state = this.db
        .prepare('SELECT * FROM micro_loss_state WHERE id = 1')
        .get() as StateRow;
      const outcomes = this.db
        .prepare(
          'SELECT net FROM micro_loss_trades WHERE epoch = ? AND net IS NOT NULL AND closed_at >= ? AND closed_at < ? ORDER BY closed_at, trade_id',
        )
        .all(state.epoch, day, day + 86_400_000) as { net: number }[];
      let streak = 0;
      let halted = 0;
      for (const outcome of outcomes) {
        if (outcome.net < 0) streak += 1;
        else if (outcome.net > 0) streak = 0;
        if (streak >= 3) halted = 1;
      }
      // Migration derives only the daily loss gate; signed commands and unresolved trades stay intact.
      if (state.initialized) {
        this.db
          .prepare(
            'UPDATE micro_loss_state SET revision = revision + 1, streak = ?, halted = ? WHERE id = 1',
          )
          .run(streak, halted);
        this.db
          .prepare('INSERT INTO micro_loss_rollovers VALUES (?, ?, ?, ?)')
          .run(state.revision + 1, calendar?.day_start ?? null, day, now);
      }
    }
    if (!calendar || calendar.day_start !== day || persistClock)
      this.db.prepare('INSERT OR REPLACE INTO micro_loss_calendar VALUES (1, ?, ?)').run(day, now);
  }
}

function cashflows(evidence: MicroBurstSettlementEvidence): string {
  return canonical({
    fills: [...evidence.fills].sort((a, b) => a.id.localeCompare(b.id)),
    funding: [...evidence.funding].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  throw new Error('MICRO_SETTLEMENT_NON_JSON_EVIDENCE');
}
