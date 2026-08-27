#!/usr/bin/env npx tsx
/** Reads journals; analysis lives in the compiled tooling core. */
import * as fs from 'fs';
import * as path from 'path';
import { MicroBurstStorage } from '../src/app/micro-burst/MicroBurstStorage';
import { analyzeMicroBurstProspective } from '../src/tooling/micro-burst/MicroBurstProspectiveAnalyzer';
import { ProspectiveOutcomeRecord } from '../src/domain/strategies/micro-burst/MicroBurstOutcomeTypes';

const signalsDir = argument('--signals-dir') ?? 'logs/micro-burst/shadow-signals';
const outcomesDir = argument('--outcomes-dir') ?? 'logs/micro-burst/shadow-outcomes';
const seed = Number(argument('--seed') ?? '1');
const databasePath = argument('--database');
const archivePath = argument('--archive-dir');
const storage =
  databasePath && archivePath ? new MicroBurstStorage({ databasePath, archivePath }) : undefined;
const outcomeReconciliation = storage?.loadOutcomeReconciliation();

const report = analyzeMicroBurstProspective({
  signals: loadJsonl(signalsDir),
  outcomes: storage
    ? outcomeReconciliation!.outcomes
    : (loadJsonl(outcomesDir) as ProspectiveOutcomeRecord[]),
  seed: Number.isFinite(seed) ? seed : 1,
  archiveTrades: storage
    ? (symbol, fromMs, toMs) => storage.queryArchivedTrades(symbol, fromMs, toMs) as any
    : undefined,
  unresolvedOutcomeIds: outcomeReconciliation?.unresolvedOutcomeIds,
});
console.log(report.text);
storage?.close();

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function loadJsonl(directory: string): Record<string, unknown>[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .flatMap((file) =>
      fs
        .readFileSync(path.join(directory, file), 'utf8')
        .split('\n')
        .flatMap((line) => {
          if (!line.trim()) return [];
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        }),
    );
}
