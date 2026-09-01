import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type SharedRequestPriority = 'normal' | 'critical';

const CAPACITY = 1_800;
const REFILL_PER_MS = CAPACITY / 60_000;
const CRITICAL_RESERVE = 300;
const DEFAULT_DB = join(tmpdir(), 'trading_system-binance-shared-rate-limit.sqlite3');

type SharedRateLimitMetrics = {
  grants: number;
  blocked: number;
  rateLimitEvents: number;
  lastRateLimitStatus?: number;
  cooldownUntil?: number;
  availableWeight?: number;
  capacityPerMinute?: number;
  criticalReserve?: number;
};

export class SharedBinanceRateLimiter {
  private readonly db: Database.Database;
  private readonly metrics: SharedRateLimitMetrics = {
    grants: 0,
    blocked: 0,
    rateLimitEvents: 0,
  };

  constructor(
    private readonly processName: string,
    dbPath = process.env.BINANCE_SHARED_RATE_LIMIT_DB ??
      (process.env.NODE_ENV === 'test' ? `${DEFAULT_DB}.${process.pid}` : DEFAULT_DB),
  ) {
    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS binance_rate_limit_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tokens REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        cooldown_until INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO binance_rate_limit_state(id, tokens, updated_at, cooldown_until)
      VALUES (1, ${CAPACITY}, strftime('%s','now') * 1000, 0);
      CREATE TABLE IF NOT EXISTS binance_rate_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        process_name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        weight INTEGER NOT NULL,
        priority TEXT NOT NULL,
        outcome TEXT NOT NULL
      );
    `);
  }

  async acquire(
    weight: number,
    endpoint: string,
    priority: SharedRequestPriority = 'normal',
  ): Promise<void> {
    const requested = Math.max(1, Math.ceil(weight));
    while (true) {
      const waitMs = this.tryAcquire(requested, endpoint, priority);
      if (waitMs <= 0) return;
      this.metrics.blocked++;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(waitMs, 5_000)));
    }
  }

  noteRateLimit(until: number, status?: number): void {
    if (!Number.isFinite(until)) return;
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      const state = this.db.prepare(
        'SELECT cooldown_until FROM binance_rate_limit_state WHERE id = 1',
      ).get() as { cooldown_until: number };
      const cooldownUntil = Math.max(state.cooldown_until, until);
      this.db.prepare(
        'UPDATE binance_rate_limit_state SET cooldown_until = ?, updated_at = ? WHERE id = 1',
      ).run(cooldownUntil, now);
      this.db.prepare(
        'INSERT INTO binance_rate_limit_events(created_at, process_name, endpoint, weight, priority, outcome) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(now, this.processName, 'unknown', 0, 'normal', `rate_limit_${status ?? 'unknown'}`);
    });
    transaction();
    this.metrics.rateLimitEvents++;
    this.metrics.lastRateLimitStatus = status;
    this.metrics.cooldownUntil = until;
  }

  getMetrics(): SharedRateLimitMetrics {
    const state = this.db.prepare(
      'SELECT tokens, updated_at, cooldown_until FROM binance_rate_limit_state WHERE id = 1',
    ).get() as { tokens: number; updated_at: number; cooldown_until: number };
    const tokens = Math.min(CAPACITY, state.tokens + Math.max(0, Date.now() - state.updated_at) * REFILL_PER_MS);
    return {
      ...this.metrics,
      availableWeight: tokens,
      cooldownUntil: Math.max(state.cooldown_until, this.metrics.cooldownUntil ?? 0),
      capacityPerMinute: CAPACITY,
      criticalReserve: CRITICAL_RESERVE,
    };
  }

  private tryAcquire(weight: number, endpoint: string, priority: SharedRequestPriority): number {
    const now = Date.now();
    let waitMs = 0;
    const transaction = this.db.transaction(() => {
      const state = this.db.prepare(
        'SELECT tokens, updated_at, cooldown_until FROM binance_rate_limit_state WHERE id = 1',
      ).get() as { tokens: number; updated_at: number; cooldown_until: number };
      const tokens = Math.min(CAPACITY, state.tokens + Math.max(0, now - state.updated_at) * REFILL_PER_MS);
      if (state.cooldown_until > now) {
        waitMs = state.cooldown_until - now;
      } else {
        const available = priority === 'critical' ? tokens : tokens - CRITICAL_RESERVE;
        if (available >= weight) {
          this.db.prepare(
            'UPDATE binance_rate_limit_state SET tokens = ?, updated_at = ?, cooldown_until = 0 WHERE id = 1',
          ).run(tokens - weight, now);
          this.db.prepare(
            'INSERT INTO binance_rate_limit_events(created_at, process_name, endpoint, weight, priority, outcome) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(now, this.processName, endpoint, weight, priority, 'granted');
          this.metrics.grants++;
          return;
        }
        waitMs = Math.ceil((weight - available) / REFILL_PER_MS);
      }
      this.db.prepare(
        'UPDATE binance_rate_limit_state SET tokens = ?, updated_at = ? WHERE id = 1',
      ).run(tokens, now);
    });
    transaction();
    return waitMs;
  }
}
