import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import Database from 'better-sqlite3';

export interface MicroBurstStorageOptions {
  databasePath: string;
  archivePath: string;
  now?: () => number;
}

export interface ArchiveTrade {
  symbol: string;
  eventTime: number;
  receivedAtMs: number;
  [key: string]: unknown;
}

export interface ArchiveDepth {
  symbol: string;
  eventTime: number;
  receivedAtMs: number;
  E: number;
  T: number;
  U: number;
  u: number;
  pu?: number;
  b: unknown;
  a: unknown;
  [key: string]: unknown;
}

export interface ArchivedTrade extends ArchiveTrade {
  schemaVersion: 1;
}

export interface StorageHealth {
  healthy: boolean;
  errorCount: number;
  lastError: string | null;
  lastErrorAtMs: number | null;
}

interface SegmentState {
  path: string;
  type: 'trades' | 'depth';
  symbol: string;
  hourStartMs: number;
  recordCount: number;
  firstEventTimeMs: number;
  lastEventTimeMs: number;
  checksum: string;
}

/**
 * Durable, best-effort market-data storage. Methods deliberately return false
 * on an I/O failure so observational callers cannot be taken down by storage.
 */
export class MicroBurstStorage {
  private db!: Database.Database;
  private readonly now: () => number;
  private readonly segments = new Map<string, SegmentState>();
  private health: StorageHealth = {
    healthy: true,
    errorCount: 0,
    lastError: null,
    lastErrorAtMs: null,
  };

  constructor(private readonly options: MicroBurstStorageOptions) {
    this.now = options.now ?? Date.now;
    try {
      fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
      fs.mkdirSync(options.archivePath, { recursive: true });
      this.db = new Database(options.databasePath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.createSchema();
    } catch (error) {
      this.markFailure(error);
    }
  }

  appendTrade(trade: ArchiveTrade): boolean {
    return this.appendRaw('trades', trade.symbol, trade.eventTime, trade.receivedAtMs, trade);
  }

  appendDepth(depth: ArchiveDepth): boolean {
    // Keep Binance sequence and timestamp fields untouched in the archived payload.
    return this.appendRaw('depth', depth.symbol, depth.eventTime, depth.receivedAtMs, depth);
  }

  persistCheckpoint(symbol: string, eventTimeMs: number, checkpoint: unknown): boolean {
    return this.safe(() => {
      this.db
        .prepare(
          `INSERT INTO book_checkpoints (symbol, event_time_ms, checkpoint_json, created_at_ms)
        VALUES (?, ?, ?, ?)`,
        )
        .run(symbol, eventTimeMs, JSON.stringify(checkpoint), this.now());
    });
  }

  persistFeatures(symbol: string, eventTimeMs: number, features: unknown): boolean {
    return this.safe(() => {
      this.db
        .prepare(
          `INSERT INTO book_features (symbol, event_time_ms, features_json, created_at_ms)
        VALUES (?, ?, ?, ?)`,
        )
        .run(symbol, eventTimeMs, JSON.stringify(features), this.now());
    });
  }

  persistSignal(snapshot: {
    shadowSignalId: string;
    symbol: string;
    signalAtMs: number;
    [key: string]: unknown;
  }): boolean {
    return this.safe(() => {
      this.db
        .prepare(
          `INSERT INTO micro_burst_signals (signal_id, symbol, signal_at_ms, snapshot_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(signal_id) DO NOTHING`,
        )
        .run(
          snapshot.shadowSignalId,
          snapshot.symbol,
          snapshot.signalAtMs,
          JSON.stringify(snapshot),
          this.now(),
        );
    });
  }

  persistPendingState(signalId: string, status: string, state: unknown): boolean {
    return this.safe(() => {
      this.db
        .prepare(
          `INSERT INTO micro_burst_pending_outcomes (signal_id, status, state_json, updated_at_ms)
        VALUES (?, ?, ?, ?) ON CONFLICT(signal_id) DO UPDATE SET status = excluded.status,
        state_json = excluded.state_json, updated_at_ms = excluded.updated_at_ms`,
        )
        .run(signalId, status, JSON.stringify(state), this.now());
    });
  }

  completeOutcome(outcome: {
    shadowSignalId: string;
    symbol: string;
    completedAtMs: number;
    [key: string]: unknown;
  }): boolean {
    return this.safe(() =>
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO micro_burst_outcomes (signal_id, symbol, completed_at_ms, outcome_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(signal_id) DO NOTHING`,
          )
          .run(
            outcome.shadowSignalId,
            outcome.symbol,
            outcome.completedAtMs,
            JSON.stringify(outcome),
            this.now(),
          );
        this.db
          .prepare(
            `UPDATE micro_burst_pending_outcomes SET status = 'COMPLETED', updated_at_ms = ? WHERE signal_id = ?`,
          )
          .run(this.now(), outcome.shadowSignalId);
      })(),
    );
  }

  persistCohort(cohort: { cohortId: string; [key: string]: unknown }): boolean {
    return this.safe(() => {
      this.db
        .prepare(
          `INSERT INTO micro_burst_cohorts (cohort_id, cohort_json, updated_at_ms)
        VALUES (?, ?, ?) ON CONFLICT(cohort_id) DO UPDATE SET cohort_json = excluded.cohort_json,
        updated_at_ms = excluded.updated_at_ms`,
        )
        .run(cohort.cohortId, JSON.stringify(cohort), this.now());
    });
  }

  recordGap(gap: {
    symbol: string;
    startedAtMs: number;
    endedAtMs: number;
    reason: string;
    [key: string]: unknown;
  }): boolean {
    return this.safe(() => {
      this.db
        .prepare(
          `INSERT INTO market_data_gaps (symbol, started_at_ms, ended_at_ms, reason, details_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          gap.symbol,
          gap.startedAtMs,
          gap.endedAtMs,
          gap.reason,
          JSON.stringify(gap),
          this.now(),
        );
    });
  }

  recoverPending(): Array<{ signalId: string; status: string; snapshot: unknown; state: unknown }> {
    return this.safeValue(
      () =>
        this.db
          .prepare(
            `SELECT p.signal_id, p.status, p.state_json, s.snapshot_json
      FROM micro_burst_pending_outcomes p JOIN micro_burst_signals s ON s.signal_id = p.signal_id
      WHERE p.status != 'COMPLETED' ORDER BY s.signal_at_ms`,
          )
          .all()
          .map((row: any) => ({
            signalId: row.signal_id,
            status: row.status,
            snapshot: JSON.parse(row.snapshot_json),
            state: JSON.parse(row.state_json),
          })),
      [],
    );
  }

  queryArchivedTrades(symbol: string, fromMs: number, toMs: number): ArchivedTrade[] {
    const records: ArchivedTrade[] = [];
    for (const file of this.listArchiveFiles('trades', symbol)) {
      try {
        const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as ArchivedTrade & { payload?: ArchiveTrade };
            const payload = record.payload ?? {};
            const replayRecord = { ...record, ...payload, payload } as ArchivedTrade;
            if (replayRecord.eventTime >= fromMs && replayRecord.eventTime <= toMs) {
              records.push(replayRecord);
            }
          } catch {
            /* A torn NDJSON line does not invalidate earlier replay records. */
          }
        }
      } catch (error) {
        this.markFailure(error);
      }
    }
    return records.sort((a, b) => a.eventTime - b.eventTime || a.receivedAtMs - b.receivedAtMs);
  }

  flush(): boolean {
    return this.safe(() => {
      for (const state of this.segments.values()) this.writeSegmentMetadata(state);
    });
  }

  close(): void {
    this.safe(() => {
      this.flush();
      this.db?.close();
    });
  }

  getHealth(): StorageHealth {
    return { ...this.health };
  }

  private appendRaw(
    type: 'trades' | 'depth',
    symbol: string,
    eventTime: number,
    receivedAtMs: number,
    payload: unknown,
  ): boolean {
    if (!symbol || !Number.isFinite(eventTime) || !Number.isFinite(receivedAtMs)) {
      this.markFailure(new Error('invalid archive record metadata'));
      return false;
    }
    return this.safe(() => {
      const hourStartMs = Math.floor(eventTime / 3_600_000) * 3_600_000;
      const key = `${type}:${symbol}:${hourStartMs}`;
      let state = this.segments.get(key);
      if (!state) {
        const filePath = this.segmentPath(type, symbol, hourStartMs);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        state = {
          path: filePath,
          type,
          symbol,
          hourStartMs,
          recordCount: 0,
          firstEventTimeMs: eventTime,
          lastEventTimeMs: eventTime,
          checksum: '',
        };
        this.segments.set(key, state);
      }
      const record = { schemaVersion: 1, type, symbol, eventTime, receivedAtMs, payload };
      const line = JSON.stringify(record) + '\n';
      // Each append is an independent gzip member, making a process crash unable to corrupt prior records.
      fs.appendFileSync(state.path, zlib.gzipSync(Buffer.from(line, 'utf8')));
      state.recordCount++;
      state.lastEventTimeMs = eventTime;
      state.checksum = crypto
        .createHash('sha256')
        .update(state.checksum)
        .update(line)
        .digest('hex');
      this.writeSegmentMetadata(state);
    });
  }

  private segmentPath(type: 'trades' | 'depth', symbol: string, hourStartMs: number): string {
    const date = new Date(hourStartMs);
    const safeSymbol = symbol.replace(/[^A-Za-z0-9_-]/g, '_');
    const hour = date.toISOString().replace(/[:.]/g, '-');
    return path.join(this.options.archivePath, type, safeSymbol, `${hour}.ndjson.gz`);
  }

  private writeSegmentMetadata(state: SegmentState): void {
    const metadata = {
      schemaVersion: 1,
      type: state.type,
      symbol: state.symbol,
      hourStartMs: state.hourStartMs,
      recordCount: state.recordCount,
      firstEventTimeMs: state.firstEventTimeMs,
      lastEventTimeMs: state.lastEventTimeMs,
      checksum: state.checksum,
      file: path.basename(state.path),
    };
    fs.writeFileSync(`${state.path}.meta.json`, JSON.stringify(metadata) + '\n', 'utf8');
    this.db
      .prepare(
        `INSERT INTO market_data_segments (file_path, data_type, symbol, hour_start_ms, record_count,
      first_event_time_ms, last_event_time_ms, checksum, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET record_count = excluded.record_count, last_event_time_ms = excluded.last_event_time_ms,
      checksum = excluded.checksum, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        state.path,
        state.type,
        state.symbol,
        state.hourStartMs,
        state.recordCount,
        state.firstEventTimeMs,
        state.lastEventTimeMs,
        state.checksum,
        this.now(),
      );
  }

  private listArchiveFiles(type: 'trades' | 'depth', symbol: string): string[] {
    const dir = path.join(this.options.archivePath, type, symbol.replace(/[^A-Za-z0-9_-]/g, '_'));
    try {
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.ndjson.gz'))
            .map((name) => path.join(dir, name))
        : [];
    } catch (error) {
      this.markFailure(error);
      return [];
    }
  }

  private safe(action: () => void): boolean {
    try {
      action();
      return true;
    } catch (error) {
      this.markFailure(error);
      return false;
    }
  }

  private safeValue<T>(action: () => T, fallback: T): T {
    try {
      return action();
    } catch (error) {
      this.markFailure(error);
      return fallback;
    }
  }

  private markFailure(error: unknown): void {
    this.health = {
      healthy: false,
      errorCount: this.health.errorCount + 1,
      lastError: String(error),
      lastErrorAtMs: this.now(),
    };
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_data_segments (file_path TEXT PRIMARY KEY, data_type TEXT NOT NULL, symbol TEXT NOT NULL, hour_start_ms INTEGER NOT NULL, record_count INTEGER NOT NULL, first_event_time_ms INTEGER NOT NULL, last_event_time_ms INTEGER NOT NULL, checksum TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS book_checkpoints (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, event_time_ms INTEGER NOT NULL, checkpoint_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS book_features (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, event_time_ms INTEGER NOT NULL, features_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS micro_burst_signals (signal_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, signal_at_ms INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS micro_burst_outcomes (signal_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, completed_at_ms INTEGER NOT NULL, outcome_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS micro_burst_pending_outcomes (signal_id TEXT PRIMARY KEY, status TEXT NOT NULL, state_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS micro_burst_cohorts (cohort_id TEXT PRIMARY KEY, cohort_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS market_data_gaps (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, reason TEXT NOT NULL, details_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_segments_symbol_hour ON market_data_segments(symbol, hour_start_ms);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_symbol_time ON book_checkpoints(symbol, event_time_ms);
      CREATE INDEX IF NOT EXISTS idx_features_symbol_time ON book_features(symbol, event_time_ms);
      CREATE INDEX IF NOT EXISTS idx_signals_symbol_time ON micro_burst_signals(symbol, signal_at_ms);
      CREATE INDEX IF NOT EXISTS idx_outcomes_symbol_time ON micro_burst_outcomes(symbol, completed_at_ms);
      CREATE INDEX IF NOT EXISTS idx_pending_status ON micro_burst_pending_outcomes(status);
      CREATE INDEX IF NOT EXISTS idx_gaps_symbol_time ON market_data_gaps(symbol, started_at_ms);
    `);
  }
}
