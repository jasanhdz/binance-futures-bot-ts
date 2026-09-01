"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SharedBinanceRateLimiter = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const CAPACITY = 1800;
const REFILL_PER_MS = CAPACITY / 60000;
const CRITICAL_RESERVE = 300;
const DEFAULT_DB = (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'trading_system-binance-shared-rate-limit.sqlite3');
const SQLITE_BUSY_RETRIES = 5;
const SQLITE_BUSY_JITTER_MIN_MS = 5;
const SQLITE_BUSY_JITTER_MAX_MS = 35;
class SharedBinanceRateLimiter {
    constructor(processName, dbPath = process.env.BINANCE_SHARED_RATE_LIMIT_DB ??
        (process.env.NODE_ENV === 'test' ? `${DEFAULT_DB}.${process.pid}` : DEFAULT_DB)) {
        this.processName = processName;
        this.metrics = {
            grants: 0,
            blocked: 0,
            rateLimitEvents: 0,
        };
        this.db = new better_sqlite3_1.default(dbPath);
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
    async acquire(weight, endpoint, priority = 'normal') {
        const requested = Math.max(1, Math.ceil(weight));
        while (true) {
            const waitMs = this.tryAcquire(requested, endpoint, priority);
            if (waitMs <= 0)
                return;
            this.metrics.blocked++;
            await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5000)));
        }
    }
    noteRateLimit(until, status) {
        if (!Number.isFinite(until))
            return;
        const now = Date.now();
        const transaction = this.db.transaction(() => {
            const state = this.db.prepare('SELECT cooldown_until FROM binance_rate_limit_state WHERE id = 1').get();
            const cooldownUntil = Math.max(state.cooldown_until, until);
            this.db.prepare('UPDATE binance_rate_limit_state SET cooldown_until = ?, updated_at = ? WHERE id = 1').run(cooldownUntil, now);
            this.db.prepare('INSERT INTO binance_rate_limit_events(created_at, process_name, endpoint, weight, priority, outcome) VALUES (?, ?, ?, ?, ?, ?)').run(now, this.processName, 'unknown', 0, 'normal', `rate_limit_${status ?? 'unknown'}`);
        }).immediate;
        this.runWithBusyRetry(transaction);
        this.metrics.rateLimitEvents++;
        this.metrics.lastRateLimitStatus = status;
        this.metrics.cooldownUntil = until;
    }
    getMetrics() {
        const state = this.db.prepare('SELECT tokens, updated_at, cooldown_until FROM binance_rate_limit_state WHERE id = 1').get();
        const tokens = Math.min(CAPACITY, state.tokens + Math.max(0, Date.now() - state.updated_at) * REFILL_PER_MS);
        return {
            ...this.metrics,
            availableWeight: tokens,
            cooldownUntil: Math.max(state.cooldown_until, this.metrics.cooldownUntil ?? 0),
            capacityPerMinute: CAPACITY,
            criticalReserve: CRITICAL_RESERVE,
        };
    }
    tryAcquire(weight, endpoint, priority) {
        const now = Date.now();
        let waitMs = 0;
        const transaction = this.db.transaction(() => {
            const state = this.db.prepare('SELECT tokens, updated_at, cooldown_until FROM binance_rate_limit_state WHERE id = 1').get();
            const tokens = Math.min(CAPACITY, state.tokens + Math.max(0, now - state.updated_at) * REFILL_PER_MS);
            if (state.cooldown_until > now) {
                waitMs = state.cooldown_until - now;
            }
            else {
                const available = priority === 'critical' ? tokens : tokens - CRITICAL_RESERVE;
                if (available >= weight) {
                    this.db.prepare('UPDATE binance_rate_limit_state SET tokens = ?, updated_at = ?, cooldown_until = 0 WHERE id = 1').run(tokens - weight, now);
                    this.db.prepare('INSERT INTO binance_rate_limit_events(created_at, process_name, endpoint, weight, priority, outcome) VALUES (?, ?, ?, ?, ?, ?)').run(now, this.processName, endpoint, weight, priority, 'granted');
                    this.metrics.grants++;
                    return;
                }
                waitMs = Math.ceil((weight - available) / REFILL_PER_MS);
            }
            this.db.prepare('UPDATE binance_rate_limit_state SET tokens = ?, updated_at = ? WHERE id = 1').run(tokens, now);
        }).immediate;
        this.runWithBusyRetry(transaction);
        return waitMs;
    }
    runWithBusyRetry(transaction) {
        for (let attempt = 0; attempt <= SQLITE_BUSY_RETRIES; attempt += 1) {
            try {
                return transaction();
            }
            catch (error) {
                const code = error && typeof error === 'object' ? error.code : undefined;
                if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED')
                    throw error;
                if (attempt === SQLITE_BUSY_RETRIES)
                    throw error;
                const jitter = SQLITE_BUSY_JITTER_MIN_MS + Math.floor(Math.random() * (SQLITE_BUSY_JITTER_MAX_MS - SQLITE_BUSY_JITTER_MIN_MS + 1));
                const atomics = new Int32Array(new SharedArrayBuffer(4));
                Atomics.wait(atomics, 0, 0, jitter);
            }
        }
    }
}
exports.SharedBinanceRateLimiter = SharedBinanceRateLimiter;
