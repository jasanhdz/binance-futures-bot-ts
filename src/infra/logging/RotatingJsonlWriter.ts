import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export interface RotatingJsonlWriterOptions {
  maxBytes?: number;
  compressRotated?: boolean;
  retentionDays?: number;
  maxPendingWrites?: number;
  now?: () => number;
}

export interface RotatingJsonlWriterMetrics {
  recordsWritten: number;
  bytesWritten: number;
  writeFailures: number;
  rotations: number;
  compressions: number;
  compressionFailures: number;
  retentionDeleted: number;
  pendingWrites: number;
  peakPendingWrites: number;
  overloadRejected: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PENDING_WRITES = 256;

/**
 * Serial append-only JSONL writer with bounded active files. Rotation is a
 * rename, so the trading path never has to read an old archive into memory.
 * Compression runs in the background and is observational/fail-open.
 */
export class RotatingJsonlWriter {
  private queue: Promise<void> = Promise.resolve();
  private currentBytes: number | undefined;
  private rotationSequence = 0;
  private pendingWrites = 0;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly metrics: RotatingJsonlWriterMetrics = {
    recordsWritten: 0,
    bytesWritten: 0,
    writeFailures: 0,
    rotations: 0,
    compressions: 0,
    compressionFailures: 0,
    retentionDeleted: 0,
    pendingWrites: 0,
    peakPendingWrites: 0,
    overloadRejected: 0,
  };

  constructor(
    private readonly filePath: string,
    private readonly options: RotatingJsonlWriterOptions = {},
  ) {}

  append(record: unknown): Promise<void> {
    const maxPendingWrites = Math.max(
      1,
      Math.floor(this.options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES),
    );
    if (this.pendingWrites >= maxPendingWrites) {
      this.metrics.overloadRejected += 1;
      return Promise.reject(new Error('JSONL_WRITER_BACKPRESSURE_LIMIT'));
    }

    const line = `${JSON.stringify(record)}\n`;
    this.pendingWrites += 1;
    this.metrics.pendingWrites = this.pendingWrites;
    this.metrics.peakPendingWrites = Math.max(this.metrics.peakPendingWrites, this.pendingWrites);
    const operation = this.queue
      .then(() => this.appendLine(line))
      .catch((error) => {
        this.metrics.writeFailures += 1;
        throw error;
      })
      .finally(() => {
        this.pendingWrites -= 1;
        this.metrics.pendingWrites = this.pendingWrites;
      });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  health(): Readonly<RotatingJsonlWriterMetrics> {
    return { ...this.metrics };
  }

  async drain(): Promise<void> {
    await this.queue;
    await Promise.allSettled([...this.backgroundTasks]);
  }

  private async appendLine(line: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const bytes = Buffer.byteLength(line);
    if (this.currentBytes === undefined) this.currentBytes = await this.readCurrentSize();
    const maxBytes = Math.max(1, this.options.maxBytes ?? DEFAULT_MAX_BYTES);
    if (this.currentBytes > 0 && this.currentBytes + bytes > maxBytes) await this.rotate();
    await appendFile(this.filePath, line, 'utf8');
    this.currentBytes += bytes;
    this.metrics.recordsWritten += 1;
    this.metrics.bytesWritten += bytes;
  }

  private async readCurrentSize(): Promise<number> {
    try {
      return (await stat(this.filePath)).size;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  private async rotate(): Promise<void> {
    const rotated = this.rotatedPath();
    try {
      await rename(this.filePath, rotated);
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.currentBytes = 0;
      return;
    }
    this.currentBytes = 0;
    this.metrics.rotations += 1;
    if (this.options.compressRotated !== false) this.scheduleCompression(rotated);
    this.scheduleRetention();
  }

  private rotatedPath(): string {
    const parsed = parse(this.filePath);
    const timestamp = new Date((this.options.now ?? Date.now)())
      .toISOString()
      .replace(/[:.]/g, '-');
    this.rotationSequence += 1;
    return join(parsed.dir, `${parsed.name}.${timestamp}.${this.rotationSequence}${parsed.ext}`);
  }

  private scheduleCompression(rotatedPath: string): void {
    const compressedPath = `${rotatedPath}.gz`;
    const task = pipeline(
      createReadStream(rotatedPath),
      createGzip({ level: 1 }),
      createWriteStream(compressedPath, { flags: 'wx' }),
    )
      .then(async () => {
        await unlink(rotatedPath);
        this.metrics.compressions += 1;
      })
      .catch(async () => {
        await unlink(compressedPath).catch(() => undefined);
        this.metrics.compressionFailures += 1;
      });
    this.track(task);
  }

  private scheduleRetention(): void {
    const retentionDays = this.options.retentionDays;
    if (!Number.isFinite(retentionDays) || (retentionDays ?? 0) <= 0) return;
    const task = this.applyRetention(retentionDays as number).catch(() => undefined);
    this.track(task);
  }

  private async applyRetention(retentionDays: number): Promise<void> {
    const parsed = parse(this.filePath);
    const cutoff = (this.options.now ?? Date.now)() - retentionDays * 86_400_000;
    const entries = await readdir(parsed.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${parsed.name}.`)) continue;
      if (![parsed.ext, `${parsed.ext}.gz`].some((suffix) => entry.name.endsWith(suffix))) continue;
      const path = join(parsed.dir, entry.name);
      const metadata = await stat(path);
      if (metadata.mtimeMs >= cutoff) continue;
      await unlink(path);
      this.metrics.retentionDeleted += 1;
    }
  }

  private track(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => this.backgroundTasks.delete(task));
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
