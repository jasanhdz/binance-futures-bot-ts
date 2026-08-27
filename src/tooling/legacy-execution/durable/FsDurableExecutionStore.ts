import fs from 'node:fs';
import path from 'node:path';
import {
  DurableExecutionError,
  DurableExecutionRecord,
  DurableExecutionStore,
} from './DurableExecutionLifecycle';

export class FsDurableExecutionStore implements DurableExecutionStore {
  private readonly records = new Map<string, DurableExecutionRecord>();
  private readonly journalPath: string;

  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.journalPath = path.join(root, 'execution-lifecycle-v1.jsonl');
    this.load();
  }

  get(intentId: string): DurableExecutionRecord | null {
    const record = this.records.get(intentId);
    return record ? structuredClone(record) : null;
  }

  put(record: DurableExecutionRecord, expectedRevision: number | null): void {
    const current = this.records.get(record.intent.intentId);
    if (
      expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision
    ) {
      throw new DurableExecutionError('DURABLE_STORE_REVISION_CONFLICT');
    }
    const line = `${JSON.stringify(record)}\n`;
    const fd = fs.openSync(this.journalPath, 'a', 0o600);
    try {
      fs.writeSync(fd, line, undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.records.set(record.intent.intentId, structuredClone(record));
  }

  listNonTerminal(): DurableExecutionRecord[] {
    return [...this.records.values()]
      .filter((record) => !['CLOSED', 'FAILED_CLOSED'].includes(record.state))
      .map((record) => structuredClone(record));
  }

  private load(): void {
    if (!fs.existsSync(this.journalPath)) return;
    const lines = fs.readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let record: DurableExecutionRecord;
      try {
        record = JSON.parse(line) as DurableExecutionRecord;
      } catch (error) {
        throw new DurableExecutionError(`DURABLE_JOURNAL_CORRUPT:${String(error)}`);
      }
      if (record.schemaVersion !== 'aegis-durable-execution-lifecycle-v1') {
        throw new DurableExecutionError('DURABLE_JOURNAL_SCHEMA_MISMATCH');
      }
      const previous = this.records.get(record.intent.intentId);
      const expected = previous ? previous.revision + 1 : 1;
      if (record.revision !== expected) {
        throw new DurableExecutionError('DURABLE_JOURNAL_REVISION_GAP');
      }
      this.records.set(record.intent.intentId, record);
    }
  }
}
