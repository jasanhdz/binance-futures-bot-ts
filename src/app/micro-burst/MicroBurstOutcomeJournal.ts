import * as fs from 'fs';
import * as path from 'path';
import { ProspectiveOutcomeRecord } from '../../domain/strategies/micro-burst/MicroBurstOutcomeTypes';

const DEFAULT_OUTCOME_DIR = 'logs/micro-burst/shadow-outcomes';
const MAX_ENTRIES_PER_FILE = 10_000;

export class MicroBurstOutcomeJournal {
  private entryCount = 0;
  private currentFilePath: string | null = null;
  private readonly writtenIds = new Set<string>();

  constructor(
    private readonly journalDir: string = DEFAULT_OUTCOME_DIR,
    private readonly maxEntriesPerFile = MAX_ENTRIES_PER_FILE,
  ) {
    this.loadWrittenIds();
  }

  append(record: ProspectiveOutcomeRecord): boolean {
    if (this.writtenIds.has(record.shadowSignalId)) return true;

    const json = JSON.stringify(record);

    try {
      this.ensureDir();
      if (!this.currentFilePath || this.entryCount >= this.maxEntriesPerFile) {
        this.rotateFile();
      }
      const fd = fs.openSync(this.currentFilePath!, 'a');
      try {
        fs.writeSync(fd, json + '\n', undefined, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.writtenIds.add(record.shadowSignalId);
      this.entryCount++;
      return true;
    } catch {
      this.loadWrittenIds();
      if (this.writtenIds.has(record.shadowSignalId)) return true;
      // Journal write failure must not crash runtime
      return false;
    }
  }

  flush(): void {
    this.entryCount = 0;
    this.currentFilePath = null;
  }

  getWrittenIds(): ReadonlySet<string> {
    return this.writtenIds;
  }

  getEntryCount(): number {
    return this.entryCount;
  }

  getCurrentFilePath(): string | null {
    return this.currentFilePath;
  }

  /** Load all completed outcome records from journal files (for analyzer). */
  loadAll(): ProspectiveOutcomeRecord[] {
    const records: ProspectiveOutcomeRecord[] = [];
    try {
      if (!fs.existsSync(this.journalDir)) return records;
      const files = fs
        .readdirSync(this.journalDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort();
      for (const file of files) {
        const content = fs.readFileSync(path.join(this.journalDir, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            records.push(JSON.parse(line) as ProspectiveOutcomeRecord);
          } catch {
            /* skip malformed lines */
          }
        }
      }
    } catch {
      /* directory read failure */
    }
    return records;
  }

  /** Load all pending signal IDs that were journaled but not yet completed (for restart recovery). */
  loadPendingSignalIds(): Set<string> {
    const completed = new Set<string>();
    try {
      if (!fs.existsSync(this.journalDir)) return completed;
      const files = fs.readdirSync(this.journalDir).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(this.journalDir, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as ProspectiveOutcomeRecord;
            completed.add(record.shadowSignalId);
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* ok */
    }
    return completed;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.journalDir)) {
      fs.mkdirSync(this.journalDir, { recursive: true });
    }
  }

  private loadWrittenIds(): void {
    try {
      if (!fs.existsSync(this.journalDir)) return;
      for (const file of fs.readdirSync(this.journalDir).filter((f) => f.endsWith('.jsonl'))) {
        const content = fs.readFileSync(path.join(this.journalDir, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as ProspectiveOutcomeRecord;
            if (record.shadowSignalId) this.writtenIds.add(record.shadowSignalId);
          } catch {
            /* Ignore malformed rows during restart recovery. */
          }
        }
      }
    } catch {
      /* Append reports journal I/O failures. */
    }
  }

  private rotateFile(): void {
    const date = new Date().toISOString().slice(0, 10);
    const ts = Date.now();
    this.currentFilePath = path.join(this.journalDir, `${date}-${ts}.jsonl`);
    this.entryCount = 0;
  }
}
