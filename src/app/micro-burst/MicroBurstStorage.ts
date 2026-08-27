import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import Database from 'better-sqlite3';
import { compareTrades, tradeIdentity } from './MicroBurstTradeHistoryStore';

export interface MicroBurstStorageOptions {
  databasePath: string;
  archivePath: string;
  now?: () => number;
  /** Maximum in-memory archival work items accepted before overflow is recorded as a durable gap. */
  maxArchiveQueueRecords?: number;
  /** Maximum records in an active spool before it is finalized. */
  maxActiveSegmentRecords?: number;
  /** Maximum bytes in an active spool before it is finalized. */
  maxActiveSegmentBytes?: number;
  /** Maximum elapsed time for an active spool before it is finalized. */
  maxActiveSegmentDurationMs?: number;
  /** Maximum interval between fsync durability checkpoints. */
  durabilityFlushIntervalMs?: number;
  /** @deprecated M3.2.4 compatibility alias for maxActiveSegmentRecords. */
  maxArchiveBatchRecords?: number;
  /** @deprecated M3.2.4 compatibility alias for durabilityFlushIntervalMs. */
  maxBatchLatencyMs?: number;
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
  queueDepth: number;
  queueCapacity: number;
  queueHighWatermark: number;
  queuedRecords: number;
  writtenRecords: number;
  overflowRecords: number;
  draining: boolean;
  activeSegmentCount: number;
  activeSegmentRecords: number;
  activeSegmentBytes: number;
  segmentsFinalized: number;
  recordsDurablyFlushed: number;
  finalizationQueueDepth: number;
  finalizationQueueHighWatermark: number;
  recoveryActions: number;
  recoveryFailures: number;
  lastDurableAtMs: number | null;
  /** M3.2.4 compatibility aliases. */
  activeBatchCount: number;
  openBatchRecords: number;
  segmentsWritten: number;
  averageRecordsPerSegment: number;
}

interface ArchiveWrite {
  type: 'trades' | 'depth';
  symbol: string;
  eventTime: number;
  receivedAtMs: number;
  payload: unknown;
}

interface ActiveSegment {
  key: string;
  type: 'trades' | 'depth';
  symbol: string;
  hourStartMs: number;
  activePath: string;
  records: number;
  bytes: number;
  firstEventTimeMs: number;
  lastEventTimeMs: number;
  startedAtMs: number;
  durablyFlushedRecords: number;
  durabilityTimer: NodeJS.Timeout | null;
  rotationTimer: NodeJS.Timeout | null;
}

interface ArchiveSegmentMetadata {
  schemaVersion: 1;
  type: 'trades' | 'depth';
  symbol: string;
  hourStartMs: number;
  recordCount: number;
  firstEventTimeMs: number;
  lastEventTimeMs: number;
  checksum: string;
  segmentId: string;
  file: string;
}

const DEFAULT_MAX_ARCHIVE_QUEUE_RECORDS = 50_000;
const DEFAULT_MAX_ACTIVE_SEGMENT_RECORDS = 5_000;
const DEFAULT_MAX_ACTIVE_SEGMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ACTIVE_SEGMENT_DURATION_MS = 120_000;
const DEFAULT_DURABILITY_FLUSH_INTERVAL_MS = 1_000;

/**
 * Durable, best-effort market-data storage. Methods deliberately return false
 * on an I/O failure so observational callers cannot be taken down by storage.
 */
export class MicroBurstStorage {
  private db!: Database.Database;
  private readonly now: () => number;
  private readonly maxArchiveQueueRecords: number;
  private readonly maxActiveSegmentRecords: number;
  private readonly maxActiveSegmentBytes: number;
  private readonly maxActiveSegmentDurationMs: number;
  private readonly durabilityFlushIntervalMs: number;
  private readonly activeSegments = new Map<string, ActiveSegment>();
  private health: StorageHealth = {
    healthy: true,
    errorCount: 0,
    lastError: null,
    lastErrorAtMs: null,
    queueDepth: 0,
    queueCapacity: 0,
    queueHighWatermark: 0,
    queuedRecords: 0,
    writtenRecords: 0,
    overflowRecords: 0,
    draining: false,
    activeSegmentCount: 0,
    activeSegmentRecords: 0,
    activeSegmentBytes: 0,
    segmentsFinalized: 0,
    recordsDurablyFlushed: 0,
    finalizationQueueDepth: 0,
    finalizationQueueHighWatermark: 0,
    recoveryActions: 0,
    recoveryFailures: 0,
    lastDurableAtMs: null,
    activeBatchCount: 0,
    openBatchRecords: 0,
    segmentsWritten: 0,
    averageRecordsPerSegment: 0,
  };

  constructor(private readonly options: MicroBurstStorageOptions) {
    this.now = options.now ?? Date.now;
    this.maxArchiveQueueRecords = positiveInteger(
      options.maxArchiveQueueRecords,
      DEFAULT_MAX_ARCHIVE_QUEUE_RECORDS,
    );
    this.maxActiveSegmentRecords = positiveInteger(
      options.maxActiveSegmentRecords ?? options.maxArchiveBatchRecords,
      DEFAULT_MAX_ACTIVE_SEGMENT_RECORDS,
    );
    this.maxActiveSegmentBytes = positiveInteger(options.maxActiveSegmentBytes, DEFAULT_MAX_ACTIVE_SEGMENT_BYTES);
    this.maxActiveSegmentDurationMs = positiveInteger(options.maxActiveSegmentDurationMs, DEFAULT_MAX_ACTIVE_SEGMENT_DURATION_MS);
    this.durabilityFlushIntervalMs = positiveInteger(
      options.durabilityFlushIntervalMs ?? options.maxBatchLatencyMs,
      DEFAULT_DURABILITY_FLUSH_INTERVAL_MS,
    );
    this.health.queueCapacity = this.maxArchiveQueueRecords;
    try {
      fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
      fs.mkdirSync(options.archivePath, { recursive: true });
      this.db = new Database(options.databasePath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.createSchema();
      this.recoverArchive();
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
        state_json = excluded.state_json, updated_at_ms = excluded.updated_at_ms
        WHERE micro_burst_pending_outcomes.status NOT IN ('COMPLETED', 'INCOMPLETE_DATA_GAP', 'EVICTED_CAPACITY')`,
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
            `INSERT INTO micro_burst_outcomes (signal_id, symbol, completed_at_ms, outcome_json, journal_status, created_at_ms)
         VALUES (?, ?, ?, ?, 'PENDING', ?) ON CONFLICT(signal_id) DO NOTHING`,
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

  markOutcomeJournaled(signalId: string): boolean {
    return this.safe(() => {
      this.db
        .prepare(`UPDATE micro_burst_outcomes SET journal_status = 'WRITTEN' WHERE signal_id = ?`)
        .run(signalId);
    });
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
       WHERE p.status NOT IN ('COMPLETED', 'INCOMPLETE_DATA_GAP', 'EVICTED_CAPACITY') ORDER BY s.signal_at_ms`,
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
    for (const file of this.listArchiveFiles('trades', symbol, fromMs, toMs)) {
      try {
        const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
        const metadata = this.readAndVerifySegmentMetadata(file, text);
        if (!metadata) {
          this.recordReplayGap(symbol, file, fromMs, toMs, 'archive_segment_corrupt');
          continue;
        }
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
        this.recordReplayGap(symbol, file, fromMs, toMs, 'archive_segment_unreadable');
      }
    }
    const deduped = new Map<string, ArchivedTrade>();
    for (const record of records) {
      const trade =
        record as unknown as import('../../domain/strategies/micro-burst/MicroBurstOutcomeTypes').MicroBurstTradeRecord;
      if (!deduped.has(tradeIdentity(trade))) deduped.set(tradeIdentity(trade), record);
    }
    return [...deduped.values()].sort((a, b) => compareTrades(a as any, b as any));
  }

  archiveWatermark(symbol: string): number | null {
    return this.safeValue(() => {
      const row = this.db
        .prepare(
          `SELECT MAX(last_event_time_ms) AS watermark FROM market_data_segments WHERE data_type = 'trades' AND symbol = ?`,
        )
        .get(symbol) as { watermark: number | null };
      return row.watermark;
    }, null);
  }

  hasGap(symbol: string, fromMs: number, toMs: number): boolean {
    return this.safeValue(
      () =>
        Boolean(
          this.db
            .prepare(
              `SELECT 1 FROM market_data_gaps WHERE symbol = ? AND started_at_ms <= ? AND ended_at_ms >= ? LIMIT 1`,
            )
            .get(symbol, toMs, fromMs),
        ),
      true,
    );
  }

  flush(): boolean {
    return this.safe(() => {
      this.finalizeAllActiveSegments();
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
    const hourStartMs = Math.floor(eventTime / 3_600_000) * 3_600_000;
    const key = `${type}\u0000${symbol}\u0000${hourStartMs}`;
    const write: ArchiveWrite = { type, symbol, eventTime, receivedAtMs, payload };
    try {
      let active = this.activeSegments.get(key);
      if (!active) {
        active = this.openActiveSegment(type, symbol, hourStartMs);
        this.activeSegments.set(key, active);
      }
      const line = this.serialize(write);
      fs.appendFileSync(active.activePath, line, 'utf8');
      active.records++;
      active.bytes += Buffer.byteLength(line);
      active.firstEventTimeMs = Math.min(active.firstEventTimeMs, eventTime);
      active.lastEventTimeMs = Math.max(active.lastEventTimeMs, eventTime);
      this.health.queuedRecords++;
      this.scheduleDurabilityCheckpoint(active);
      this.updateActiveHealth();
      if (
        active.records >= this.maxActiveSegmentRecords ||
        active.bytes >= this.maxActiveSegmentBytes
      ) {
        this.finalizeActiveSegment(active);
      }
      return true;
    } catch (error) {
      this.markFailure(error);
      this.recordGap({
        symbol,
        startedAtMs: eventTime,
        endedAtMs: eventTime,
        reason: 'active_archive_append_failure',
        dataType: type,
      });
      return false;
    }
  }

  private segmentPath(type: 'trades' | 'depth', symbol: string, hourStartMs: number, segmentId: string): string {
    const date = new Date(hourStartMs);
    const safeSymbol = symbol.replace(/[^A-Za-z0-9_-]/g, '_');
    const hour = date.toISOString().replace(/[:.]/g, '-');
    return path.join(this.options.archivePath, type, safeSymbol, `${hour}-${segmentId}.ndjson.gz`);
  }

  private activePath(type: 'trades' | 'depth', symbol: string, hourStartMs: number): string {
    const date = new Date(hourStartMs).toISOString().replace(/[:.]/g, '-');
    return path.join(this.options.archivePath, type, symbol.replace(/[^A-Za-z0-9_-]/g, '_'), `${date}.active.ndjson`);
  }

  private openActiveSegment(type: 'trades' | 'depth', symbol: string, hourStartMs: number): ActiveSegment {
    const activePath = this.activePath(type, symbol, hourStartMs);
    fs.mkdirSync(path.dirname(activePath), { recursive: true });
    fs.closeSync(fs.openSync(activePath, 'a'));
    const active: ActiveSegment = {
      key: `${type}\u0000${symbol}\u0000${hourStartMs}`,
      type,
      symbol,
      hourStartMs,
      activePath,
      records: 0,
      bytes: 0,
      firstEventTimeMs: Number.POSITIVE_INFINITY,
      lastEventTimeMs: Number.NEGATIVE_INFINITY,
      startedAtMs: this.now(),
      durablyFlushedRecords: 0,
      durabilityTimer: null,
      rotationTimer: null,
    };
    active.rotationTimer = setTimeout(() => this.finalizeActiveSegment(active), this.maxActiveSegmentDurationMs);
    active.rotationTimer.unref?.();
    return active;
  }

  private serialize(write: ArchiveWrite): string {
    return `${JSON.stringify({ schemaVersion: 1, type: write.type, symbol: write.symbol, eventTime: write.eventTime, receivedAtMs: write.receivedAtMs, payload: write.payload })}\n`;
  }

  private scheduleDurabilityCheckpoint(active: ActiveSegment): void {
    if (active.durabilityTimer) return;
    active.durabilityTimer = setTimeout(() => {
      active.durabilityTimer = null;
      this.checkpointActiveSegment(active);
    }, this.durabilityFlushIntervalMs);
    active.durabilityTimer.unref?.();
  }

  private checkpointActiveSegment(active: ActiveSegment): void {
    if (!this.activeSegments.has(active.key) || active.records === 0) return;
    try {
      const fd = fs.openSync(active.activePath, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.health.recordsDurablyFlushed += active.records - active.durablyFlushedRecords;
      active.durablyFlushedRecords = active.records;
      this.health.lastDurableAtMs = this.now();
      this.updateActiveHealth();
    } catch (error) {
      this.markFailure(error);
      this.recordGap({ symbol: active.symbol, startedAtMs: active.firstEventTimeMs, endedAtMs: active.lastEventTimeMs, reason: 'active_archive_fsync_failure', dataType: active.type });
    }
  }

  private finalizeAllActiveSegments(): void {
    for (const active of [...this.activeSegments.values()]) this.finalizeActiveSegment(active);
  }

  private finalizeActiveSegment(active: ActiveSegment): void {
    if (!this.activeSegments.has(active.key)) return;
    this.clearActiveTimers(active);
    try {
      this.checkpointActiveSegment(active);
      const text = fs.readFileSync(active.activePath, 'utf8');
      const parsed = this.completeRecords(text);
      if (parsed.torn) {
        this.recordGap({ symbol: active.symbol, startedAtMs: active.firstEventTimeMs, endedAtMs: active.lastEventTimeMs, reason: 'active_archive_torn_line', dataType: active.type });
        this.markFailure(new Error(`torn active archive line: ${active.activePath}`));
      }
      if (parsed.records.length > 0) this.writeFinalSegment(active, parsed.text, parsed.records);
      fs.unlinkSync(active.activePath);
      this.activeSegments.delete(active.key);
    } catch (error) {
      this.markFailure(error);
      this.recordGap({ symbol: active.symbol, startedAtMs: active.firstEventTimeMs, endedAtMs: active.lastEventTimeMs, reason: 'archive_finalization_failure', dataType: active.type });
    } finally {
      this.updateActiveHealth();
    }
  }

  private clearActiveTimers(active: ActiveSegment): void {
    if (active.durabilityTimer) clearTimeout(active.durabilityTimer);
    if (active.rotationTimer) clearTimeout(active.rotationTimer);
    active.durabilityTimer = null;
    active.rotationTimer = null;
  }

  private countActiveRecords(): number {
    let total = 0;
    for (const active of this.activeSegments.values()) total += active.records;
    return total;
  }

  private updateActiveHealth(): void {
    // Active spools have already been synchronously written to disk; they are not queued work.
    this.health.queueDepth = 0;
    this.health.queueHighWatermark = Math.max(
      this.health.queueHighWatermark,
      this.health.queueDepth,
    );
    this.health.activeSegmentCount = this.activeSegments.size;
    this.health.activeSegmentRecords = this.countActiveRecords();
    this.health.activeSegmentBytes = [...this.activeSegments.values()].reduce((total, active) => total + active.bytes, 0);
    this.health.activeBatchCount = this.health.activeSegmentCount;
    this.health.openBatchRecords = this.health.activeSegmentRecords;
    this.health.draining = this.activeSegments.size > 0;
  }

  private writeFinalSegment(active: ActiveSegment, text: string, records: ArchiveWrite[]): void {
    const checksum = crypto.createHash('sha256').update(text).digest('hex');
    const segmentId = this.segmentId(active.type, active.symbol, active.hourStartMs, checksum);
    const filePath = this.segmentPath(active.type, active.symbol, active.hourStartMs, segmentId);
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const eventTimes = records.map((write) => write.eventTime);
    const gzipTempPath = `${filePath}.tmp`;
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(gzipTempPath, zlib.gzipSync(Buffer.from(text, 'utf8')), { flag: 'wx' });
      this.fsyncFile(gzipTempPath);
      fs.renameSync(gzipTempPath, filePath);
      this.fsyncDirectory(directory);
    }
    const metadata: ArchiveSegmentMetadata = {
      schemaVersion: 1,
      type: active.type,
      symbol: active.symbol,
      hourStartMs: active.hourStartMs,
      recordCount: records.length,
      firstEventTimeMs: Math.min(...eventTimes),
      lastEventTimeMs: Math.max(...eventTimes),
      checksum,
      segmentId,
      file: path.basename(filePath),
    };
    const metadataTempPath = `${filePath}.meta.json.tmp`;
    if (!fs.existsSync(`${filePath}.meta.json`)) {
      fs.writeFileSync(metadataTempPath, JSON.stringify(metadata) + '\n', { flag: 'wx' });
      this.fsyncFile(metadataTempPath);
      fs.renameSync(metadataTempPath, `${filePath}.meta.json`);
      this.fsyncDirectory(directory);
    }
    this.insertSegmentIndex(filePath, metadata);
    this.health.writtenRecords += records.length;
    this.health.segmentsFinalized++;
    this.health.segmentsWritten = this.health.segmentsFinalized;
    this.health.averageRecordsPerSegment =
      this.health.segmentsFinalized > 0
        ? Math.round((this.health.writtenRecords / this.health.segmentsFinalized) * 100) / 100
        : 0;
  }

  private fsyncFile(filePath: string): void {
    const fd = fs.openSync(filePath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  private fsyncDirectory(directory: string): void {
    let fd: number;
    try {
      fd = fs.openSync(directory, 'r');
    } catch (error) {
      if (isUnsupportedDirectorySync(error)) return;
      throw error;
    }
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    } finally {
      fs.closeSync(fd);
    }
  }

  private segmentId(type: 'trades' | 'depth', symbol: string, hourStartMs: number, checksum: string): string {
    return crypto
      .createHash('sha256')
      .update(`${type}\u0000${symbol}\u0000${hourStartMs}\u0000${checksum}`)
      .digest('hex');
  }

  private completeRecords(text: string): { text: string; records: ArchiveWrite[]; torn: boolean } {
    const lines = text.split('\n');
    const torn = lines.length > 1 && lines[lines.length - 1].trim() !== '';
    if (torn) lines.pop();
    const records: ArchiveWrite[] = [];
    const completeLines: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { type: 'trades' | 'depth'; symbol: string; eventTime: number; receivedAtMs: number; payload: unknown };
        if (!record.symbol || !Number.isFinite(record.eventTime) || !Number.isFinite(record.receivedAtMs)) throw new Error('invalid active record');
        records.push(record);
        completeLines.push(line);
      } catch {
        return { text: completeLines.length ? `${completeLines.join('\n')}\n` : '', records, torn: true };
      }
    }
    return { text: completeLines.length ? `${completeLines.join('\n')}\n` : '', records, torn };
  }

  private recoverArchive(): void {
    for (const type of ['trades', 'depth'] as const) {
      const typeDir = path.join(this.options.archivePath, type);
      if (!fs.existsSync(typeDir)) continue;
      for (const symbolDir of fs.readdirSync(typeDir, { withFileTypes: true })) {
        if (!symbolDir.isDirectory()) continue;
        const dir = path.join(typeDir, symbolDir.name);
        try {
          const names = fs.readdirSync(dir);
          for (const name of names.filter((entry) => entry.endsWith('.ndjson.gz.tmp'))) {
            const temporary = path.join(dir, name);
            const finalPath = temporary.slice(0, -4);
            const text = zlib.gunzipSync(fs.readFileSync(temporary)).toString('utf8');
            this.completeRecords(text);
            fs.renameSync(temporary, finalPath);
            this.fsyncDirectory(dir);
            this.health.recoveryActions++;
          }
          for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.ndjson.gz'))) {
            this.repairFinalSegment(path.join(dir, name));
          }
          for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.active.ndjson'))) {
            this.recoverActiveSegment(type, symbolDir.name, path.join(dir, name));
          }
          for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.meta.json.tmp'))) {
            fs.unlinkSync(path.join(dir, name));
            this.health.recoveryActions++;
          }
        } catch (error) {
          this.health.recoveryFailures++;
          this.markFailure(error);
        }
      }
    }
  }

  private recoverActiveSegment(type: 'trades' | 'depth', symbol: string, activePath: string): void {
    const text = fs.readFileSync(activePath, 'utf8');
    const parsed = this.completeRecords(text);
    if (parsed.records.length === 0) {
      fs.unlinkSync(activePath);
      this.health.recoveryActions++;
      return;
    }
    const checksum = crypto.createHash('sha256').update(parsed.text).digest('hex');
    const finalWithSameContent = fs
      .readdirSync(path.dirname(activePath))
      .filter((name) => name.endsWith('.ndjson.gz'))
      .some((name) => {
        try {
          return crypto
            .createHash('sha256')
            .update(zlib.gunzipSync(fs.readFileSync(path.join(path.dirname(activePath), name))).toString('utf8'))
            .digest('hex') === checksum;
        } catch {
          return false;
        }
      });
    if (finalWithSameContent) {
      fs.unlinkSync(activePath);
      this.health.recoveryActions++;
      return;
    }
    const first = parsed.records[0];
    const hourStartMs = Math.floor(first.eventTime / 3_600_000) * 3_600_000;
    if (parsed.torn) {
      this.recordGap({ symbol, startedAtMs: first.eventTime, endedAtMs: parsed.records[parsed.records.length - 1].eventTime, reason: 'recovery_torn_active_line', dataType: type });
      this.markFailure(new Error(`torn active archive line: ${activePath}`));
    }
    const active: ActiveSegment = {
      key: `${type}\u0000${symbol}\u0000${hourStartMs}`,
      type,
      symbol,
      hourStartMs,
      activePath,
      records: parsed.records.length,
      bytes: Buffer.byteLength(parsed.text),
      firstEventTimeMs: first.eventTime,
      lastEventTimeMs: parsed.records[parsed.records.length - 1].eventTime,
      startedAtMs: this.now(),
      durablyFlushedRecords: parsed.records.length,
      durabilityTimer: null,
      rotationTimer: null,
    };
    this.writeFinalSegment(active, parsed.text, parsed.records);
    fs.unlinkSync(activePath);
    this.health.recoveryActions++;
  }

  private repairFinalSegment(filePath: string): void {
    const text = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8');
    const parsed = this.completeRecords(text);
    if (parsed.torn || parsed.records.length === 0) throw new Error(`invalid finalized archive segment: ${filePath}`);
    const first = parsed.records[0];
    const checksum = crypto.createHash('sha256').update(parsed.text).digest('hex');
    const hourStartMs = Math.floor(first.eventTime / 3_600_000) * 3_600_000;
    const metadata: ArchiveSegmentMetadata = {
      schemaVersion: 1,
      type: first.type,
      symbol: first.symbol,
      hourStartMs,
      recordCount: parsed.records.length,
      firstEventTimeMs: Math.min(...parsed.records.map((record) => record.eventTime)),
      lastEventTimeMs: Math.max(...parsed.records.map((record) => record.eventTime)),
      checksum,
      segmentId: this.segmentId(first.type, first.symbol, hourStartMs, checksum),
      file: path.basename(filePath),
    };
    const metadataPath = `${filePath}.meta.json`;
    if (!fs.existsSync(metadataPath)) {
      fs.writeFileSync(metadataPath, JSON.stringify(metadata) + '\n', { flag: 'wx' });
      this.fsyncFile(metadataPath);
      this.fsyncDirectory(path.dirname(metadataPath));
      this.health.recoveryActions++;
    }
    const indexed = this.db.prepare(`SELECT 1 FROM market_data_segments WHERE file_path = ?`).get(filePath);
    if (!indexed) {
      this.insertSegmentIndex(filePath, metadata);
      this.health.recoveryActions++;
    }
  }

  private insertSegmentIndex(filePath: string, metadata: ArchiveSegmentMetadata): void {
    this.db
      .prepare(
        `INSERT INTO market_data_segments (file_path, segment_id, data_type, symbol, hour_start_ms, record_count,
        first_event_time_ms, last_event_time_ms, checksum, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING`,
      )
      .run(filePath, metadata.segmentId, metadata.type, metadata.symbol, metadata.hourStartMs, metadata.recordCount, metadata.firstEventTimeMs, metadata.lastEventTimeMs, metadata.checksum, this.now());
    this.db
      .prepare(`UPDATE market_data_segments SET segment_id = ? WHERE file_path = ? AND segment_id IS NULL`)
      .run(metadata.segmentId, filePath);
  }

  private readAndVerifySegmentMetadata(
    filePath: string,
    text: string,
  ): ArchiveSegmentMetadata | null {
    const metadataPath = `${filePath}.meta.json`;
    // Legacy one-record files without metadata remain readable.
    if (!fs.existsSync(metadataPath))
      return {
        schemaVersion: 1,
        type: 'trades',
        symbol: '',
        hourStartMs: 0,
        recordCount: 0,
        firstEventTimeMs: 0,
        lastEventTimeMs: 0,
        checksum: '',
        segmentId: '',
        file: path.basename(filePath),
      };
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as ArchiveSegmentMetadata;
      const count = text.split('\n').filter((line) => line.trim()).length;
      const checksum = crypto.createHash('sha256').update(text).digest('hex');
      const indexed = this.safeValue(
        () =>
          this.db
            .prepare(`SELECT checksum, record_count FROM market_data_segments WHERE file_path = ?`)
            .get(filePath) as { checksum: string; record_count: number } | undefined,
        undefined,
      );
      if (
        metadata.recordCount !== count ||
        metadata.checksum !== checksum ||
        (indexed !== undefined && (indexed.checksum !== checksum || indexed.record_count !== count))
      ) {
        this.markFailure(new Error(`archive segment checksum or metadata mismatch: ${filePath}`));
        return null;
      }
      return metadata;
    } catch (error) {
      this.markFailure(error);
      return null;
    }
  }

  private recordReplayGap(
    symbol: string,
    filePath: string,
    fallbackStartMs: number,
    fallbackEndMs: number,
    reason: string,
  ): void {
    const row = this.safeValue(
      () =>
        this.db
          .prepare(
            `SELECT first_event_time_ms, last_event_time_ms FROM market_data_segments WHERE file_path = ?`,
          )
          .get(filePath) as { first_event_time_ms: number; last_event_time_ms: number } | undefined,
      undefined,
    );
    this.recordGap({
      symbol,
      startedAtMs: row?.first_event_time_ms ?? fallbackStartMs,
      endedAtMs: row?.last_event_time_ms ?? fallbackEndMs,
      reason,
      file: path.basename(filePath),
    });
  }

  private listArchiveFiles(
    type: 'trades' | 'depth',
    symbol: string,
    fromMs?: number,
    toMs?: number,
  ): string[] {
    const dir = path.join(this.options.archivePath, type, symbol.replace(/[^A-Za-z0-9_-]/g, '_'));
    let directoryFiles: string[] = [];
    try {
      if (fs.existsSync(dir)) {
        directoryFiles = fs
          .readdirSync(dir)
          .filter((name) => name.endsWith('.ndjson.gz'))
          .map((name) => path.join(dir, name));
      }
    } catch (error) {
      this.markFailure(error);
    }
    if (fromMs !== undefined && toMs !== undefined) {
      const indexed = this.safeValue(
        () =>
          this.db
            .prepare(
              `SELECT file_path FROM market_data_segments WHERE data_type = ? AND symbol = ? AND last_event_time_ms >= ? AND first_event_time_ms <= ? ORDER BY first_event_time_ms, file_path`,
            )
            .all(type, symbol, fromMs, toMs)
            .map((row: any) => row.file_path as string),
        [],
      );
      if (indexed.length > 0) {
        const indexedSet = new Set(indexed);
        const unindexed = directoryFiles.filter((file) => !indexedSet.has(file));
        return [...indexed, ...unindexed];
      }
    }
    return directoryFiles;
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
      ...this.health,
      healthy: false,
      errorCount: this.health.errorCount + 1,
      lastError: String(error),
      lastErrorAtMs: this.now(),
    };
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_data_segments (file_path TEXT PRIMARY KEY, segment_id TEXT, data_type TEXT NOT NULL, symbol TEXT NOT NULL, hour_start_ms INTEGER NOT NULL, record_count INTEGER NOT NULL, first_event_time_ms INTEGER NOT NULL, last_event_time_ms INTEGER NOT NULL, checksum TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS book_checkpoints (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, event_time_ms INTEGER NOT NULL, checkpoint_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS book_features (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, event_time_ms INTEGER NOT NULL, features_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS micro_burst_signals (signal_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, signal_at_ms INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS micro_burst_outcomes (signal_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, completed_at_ms INTEGER NOT NULL, outcome_json TEXT NOT NULL, journal_status TEXT NOT NULL DEFAULT 'PENDING', created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS micro_burst_pending_outcomes (signal_id TEXT PRIMARY KEY, status TEXT NOT NULL, state_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS micro_burst_cohorts (cohort_id TEXT PRIMARY KEY, cohort_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS market_data_gaps (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, reason TEXT NOT NULL, details_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_segments_symbol_hour ON market_data_segments(symbol, hour_start_ms);
      CREATE INDEX IF NOT EXISTS idx_segments_range ON market_data_segments(data_type, symbol, first_event_time_ms, last_event_time_ms);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_symbol_time ON book_checkpoints(symbol, event_time_ms);
      CREATE INDEX IF NOT EXISTS idx_features_symbol_time ON book_features(symbol, event_time_ms);
      CREATE INDEX IF NOT EXISTS idx_signals_symbol_time ON micro_burst_signals(symbol, signal_at_ms);
      CREATE INDEX IF NOT EXISTS idx_outcomes_symbol_time ON micro_burst_outcomes(symbol, completed_at_ms);
      CREATE INDEX IF NOT EXISTS idx_pending_status ON micro_burst_pending_outcomes(status);
      CREATE INDEX IF NOT EXISTS idx_gaps_symbol_time ON market_data_gaps(symbol, started_at_ms);
    `);
    try {
      this.db.exec(
        `ALTER TABLE micro_burst_outcomes ADD COLUMN journal_status TEXT NOT NULL DEFAULT 'PENDING'`,
      );
    } catch {
      /* already migrated */
    }
    try {
      this.db.exec(`ALTER TABLE market_data_segments ADD COLUMN segment_id TEXT`);
    } catch {
      /* already migrated */
    }
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_segment_id ON market_data_segments(segment_id) WHERE segment_id IS NOT NULL`,
    );
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}
