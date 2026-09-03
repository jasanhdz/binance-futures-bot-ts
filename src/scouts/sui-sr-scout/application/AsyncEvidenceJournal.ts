import type { Logger } from '../../../app/ports/Logger';
import type { EvidenceEntry } from '../domain/ScoutTypes';
import * as fs from 'fs';
import * as path from 'path';

export interface AsyncEvidenceJournal {
  append(entry: EvidenceEntry): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  getEntryCount(): number;
}

export function createAsyncEvidenceJournal(
  logger: Logger,
  dataDir: string = 'data/sui-sr-scout',
): AsyncEvidenceJournal {
  let buffer: EvidenceEntry[] = [];
  let entryCount = 0;
  let stream: fs.WriteStream | null = null;

  function ensureDir(): void {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  function getFilePath(): string {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(dataDir, `evidence_${date}.jsonl`);
  }

  function openStream(): void {
    if (stream) return;
    ensureDir();
    stream = fs.createWriteStream(getFilePath(), { flags: 'a' });
  }

  return {
    append(entry: EvidenceEntry): void {
      buffer.push(entry);
      entryCount++;

      if (buffer.length >= 10) {
        openStream();
        for (const e of buffer) {
          stream!.write(JSON.stringify(e) + '\n');
        }
        buffer = [];
      }
    },

    async flush(): Promise<void> {
      if (buffer.length === 0) return;
      openStream();
      for (const e of buffer) {
        stream!.write(JSON.stringify(e) + '\n');
      }
      buffer = [];
      return new Promise((resolve) => {
        if (stream) {
          stream.end(() => resolve());
        } else {
          resolve();
        }
      });
    },

    async close(): Promise<void> {
      await this.flush();
      if (stream) {
        stream.end();
        stream = null;
      }
    },

    getEntryCount(): number {
      return entryCount;
    },
  };
}
