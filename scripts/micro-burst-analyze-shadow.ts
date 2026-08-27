#!/usr/bin/env npx tsx
/** Reads journals; analysis lives in the compiled tooling core. */
import * as fs from 'fs';
import * as path from 'path';
import { MicroBurstStorage } from '../src/app/micro-burst/MicroBurstStorage';
import { analyzeMicroBurstProspective } from '../src/tooling/micro-burst/MicroBurstProspectiveAnalyzer';
import { ProspectiveOutcomeRecord } from '../src/domain/strategies/micro-burst/MicroBurstOutcomeTypes';
import { MicroBurstOutcomeJournal } from '../src/app/micro-burst/MicroBurstOutcomeJournal';

const signalsDir = argument('--signals-dir') ?? 'logs/micro-burst/shadow-signals';
const outcomesDir = argument('--outcomes-dir') ?? 'logs/micro-burst/shadow-outcomes';
const seed = Number(argument('--seed') ?? '1');
const databasePath = argument('--database');
const archivePath = argument('--archive-dir');
const cohortId = argument('--cohort');
const outcomeJournal = new MicroBurstOutcomeJournal(outcomesDir);
const storage =
  databasePath && archivePath ? new MicroBurstStorage({ databasePath, archivePath }) : undefined;
const signalReconciliation = storage?.loadSignalReconciliation(cohortId);
const selectedOutcomeReconciliation = storage?.loadOutcomeReconciliation(cohortId);
const selectedCohort = cohortId;
const selectedSymbols = new Set(
  [...(signalReconciliation?.signals ?? []), ...(selectedOutcomeReconciliation?.outcomes ?? [])]
    .map((row) => row.symbol)
    .filter((symbol): symbol is string => typeof symbol === 'string'),
);
const requiredFeedGapCount = storage?.countRequiredFeedGaps(selectedSymbols) ?? 0;
const unknownLegacyGapCount = storage?.countUnknownLegacyGaps(selectedSymbols) ?? 0;

const report = analyzeMicroBurstProspective({
  signals: storage ? signalReconciliation!.signals : loadJsonl(signalsDir),
  outcomes: storage ? selectedOutcomeReconciliation!.outcomes : outcomeJournal.loadAll(),
  seed: Number.isFinite(seed) ? seed : 1,
  archiveTrades: storage
    ? (symbol, fromMs, toMs) => storage.queryArchivedTrades(symbol, fromMs, toMs) as any
    : undefined,
  unresolvedOutcomeIds: selectedOutcomeReconciliation?.unresolvedOutcomeIds,
  official: Boolean(storage),
  cohortId: selectedCohort,
  availableCohorts: storage?.listCohortIds(),
  sqliteInconsistencyIds: [
    ...(signalReconciliation?.inconsistentSignalIds ?? []),
    ...(selectedOutcomeReconciliation?.inconsistentOutcomeIds ?? []),
  ],
  requiredFeedGapCount,
  unknownLegacyGapCount,
  malformedJournal: outcomeJournal.getHealth(),
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
