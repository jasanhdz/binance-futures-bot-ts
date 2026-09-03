import * as fs from 'fs';
import * as path from 'path';
import type { EvidenceEntry } from '../domain/ScoutTypes';

export interface TrainingDatasetWriter {
  writeEntry(entry: EvidenceEntry): void;
  flush(): void;
  close(): void;
  getEntryCount(): number;
}

export function createTrainingDatasetWriter(
  dataDir: string = 'data/sui-sr-scout/datasets',
): TrainingDatasetWriter {
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
    return path.join(dataDir, `training_${date}.jsonl`);
  }

  function openStream(): void {
    if (stream) return;
    ensureDir();
    stream = fs.createWriteStream(getFilePath(), { flags: 'a' });
  }

  return {
    writeEntry(entry: EvidenceEntry): void {
      buffer.push(entry);
      entryCount++;

      if (buffer.length >= 20) {
        openStream();
        for (const e of buffer) {
          stream!.write(JSON.stringify(e) + '\n');
        }
        buffer = [];
      }
    },

    flush(): void {
      if (buffer.length === 0) return;
      openStream();
      for (const e of buffer) {
        stream!.write(JSON.stringify(e) + '\n');
      }
      buffer = [];
    },

    close(): void {
      this.flush();
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
