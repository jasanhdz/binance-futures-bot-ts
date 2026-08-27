import {
  DEFAULT_COST_SCENARIOS,
  EntryModelOutcome,
  EntryPriceModel,
  HorizonOutcome,
  ProspectiveOutcomeRecord,
  ShadowSignalSnapshot,
  MicroBurstTradeRecord,
} from '../../domain/strategies/micro-burst/MicroBurstOutcomeTypes';
import {
  computeHorizonOutcome,
  OUTCOME_HORIZONS_MS,
} from '../../domain/strategies/micro-burst/MicroBurstOutcomeEngine';

export interface MicroBurstProspectiveAnalysisInput {
  signals: readonly Record<string, unknown>[];
  outcomes: readonly ProspectiveOutcomeRecord[];
  seed?: number;
  /** Optional immutable archive reader. Controls are omitted unless raw trajectories are available. */
  archiveTrades?: (
    symbol: string,
    fromMs: number,
    toMs: number,
  ) => readonly MicroBurstTradeRecord[];
}

export interface MicroBurstProspectiveAnalysis {
  readonly text: string;
  readonly uniqueSignalCount: number;
  readonly uniqueOutcomeCount: number;
  readonly duplicateSignalRows: number;
  readonly duplicateOutcomeRows: number;
}

interface ModelRecord {
  outcome: ProspectiveOutcomeRecord;
  model: EntryPriceModel;
  result: EntryModelOutcome;
}

const MODEL_ORDER: readonly EntryPriceModel[] = [
  'SIGNAL_PRICE',
  'NEXT_TRADE',
  'CONSERVATIVE_SLIPPAGE',
];
const COST_LABELS = DEFAULT_COST_SCENARIOS.map((scenario) => scenario.label);

/**
 * Analyzes immutable journal rows only. It deliberately does not infer a price path
 * from aggregate horizon statistics: controls require a persisted raw trajectory.
 */
export function analyzeMicroBurstProspective(
  input: MicroBurstProspectiveAnalysisInput,
): MicroBurstProspectiveAnalysis {
  const signals = dedupe(input.signals, (row) => stringValue(row.shadowSignalId));
  const outcomes = dedupe(
    input.outcomes,
    (row) => row.shadowSignalId,
    (current, candidate) =>
      candidate.completedAtMs >= current.completedAtMs ? candidate : current,
  );
  const signalIds = new Set(
    signals.rows.map((row) => stringValue(row.shadowSignalId)).filter(isPresent),
  );
  const outcomeIds = new Set(outcomes.rows.map((row) => row.shadowSignalId));
  const missingOutcomes = [...signalIds].filter((id) => !outcomeIds.has(id)).length;
  const orphanOutcomes = [...outcomeIds].filter((id) => !signalIds.has(id)).length;
  const episodes = new Set(outcomes.rows.map((row) => row.episodeId).filter(isPresent));
  const modelRecords = outcomes.rows.flatMap(modelRecordsFor);
  const lines: string[] = [];

  lines.push('MICRO BURST V1 - PROSPECTIVE SHADOW OUTCOME ANALYSIS');
  lines.push('Immutable journal analysis; no signal-time data is changed.');
  lines.push('');
  lines.push('COVERAGE AND STORAGE');
  lines.push(
    `Signal journal rows: ${input.signals.length}; unique signal IDs: ${signals.rows.length}; duplicate rows: ${signals.duplicates}; invalid IDs: ${signals.invalid}`,
  );
  lines.push(
    `Outcome journal rows: ${input.outcomes.length}; unique completed signal IDs: ${outcomes.rows.length}; duplicate rows: ${outcomes.duplicates}; invalid IDs: ${outcomes.invalid}`,
  );
  lines.push(
    `Episodes: ${episodes.size}; signals without completed outcome: ${missingOutcomes}; outcomes without journal signal: ${orphanOutcomes}`,
  );
  lines.push(
    `Storage gaps: ${missingOutcomes + orphanOutcomes === 0 ? 'none observed' : `signal/outcome reconciliation gap (${missingOutcomes + orphanOutcomes})`}`,
  );

  const bookRows = [...signals.rows, ...outcomes.rows];
  const bookMissing = bookRows.filter(
    (row) => !book(row) || !isPresent(stringValue(book(row)?.status)),
  ).length;
  const bookUnhealthy = bookRows.filter((row) => {
    const status = stringValue(book(row)?.status).toUpperCase();
    return status !== '' && status !== 'HEALTHY' && status !== 'OK' && status !== 'READY';
  }).length;
  const bookAgeMissing = bookRows.filter(
    (row) => !Number.isFinite(numberValue(book(row)?.ageMs)),
  ).length;
  lines.push(
    `Book health: rows=${bookRows.length}; missing=${bookMissing}; non-healthy=${bookUnhealthy}; missing/invalid age=${bookAgeMissing}`,
  );

  const incompleteModels = outcomes.rows.reduce(
    (count, outcome) => count + missingModelCount(outcome),
    0,
  );
  const missingHorizons = modelRecords.reduce(
    (count, record) =>
      count + OUTCOME_HORIZONS_MS.filter((horizon) => !record.result.horizons?.[horizon]).length,
    0,
  );
  const dataGaps = modelRecords.reduce(
    (count, record) =>
      count +
      Object.values(record.result.horizons ?? {}).filter(
        (horizon) => horizon.tradeCount <= 0 || horizon.priceAtHorizon === null,
      ).length,
    0,
  );
  const missing300 = modelRecords.filter(
    (record) => !usableHorizon(record.result.horizons?.[300_000]),
  ).length;
  lines.push(
    `Outcome completeness: unavailable entry models=${incompleteModels}; missing horizons=${missingHorizons}; horizons without trade/price=${dataGaps}; missing usable 300s=${missing300}`,
  );

  lines.push('');
  lines.push(
    'COMPATIBLE COHORTS (never pooled across side, entry model, version, config, or commit)',
  );
  const cohorts = groupBy(modelRecords, (record) =>
    [
      record.outcome.strategyVersion,
      record.outcome.configHash,
      record.outcome.codeCommitSha,
      record.outcome.side,
      record.model,
    ].join('|'),
  );
  if (cohorts.size === 0) lines.push('No completed entry-model outcomes.');
  for (const [key, records] of [...cohorts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [version, config, commit, side, model] = key.split('|');
    lines.push(
      `${side} ${model} version=${version} config=${config} commit=${commit} N=${records.length}`,
    );
    for (const horizon of OUTCOME_HORIZONS_MS) {
      const values = records
        .map((record) => record.result.horizons?.[horizon])
        .filter(usableHorizon);
      if (values.length === 0) {
        lines.push(`  ${horizon / 1000}s: unavailable`);
        continue;
      }
      const returns = values.map((value) => value.finalReturnBps);
      const wins = returns.filter((value) => value > 0).length;
      lines.push(
        `  ${horizon / 1000}s: N=${values.length} mean=${format(mean(returns))}bps median=${format(percentile(returns, 50))}bps win=${format((wins / values.length) * 100)}% target=${values.filter((value) => value.barrierOutcome === 'TARGET_FIRST').length} stop=${values.filter((value) => value.barrierOutcome === 'STOP_FIRST').length}`,
      );
    }
    const horizon300 = records
      .map((record) => record.result.horizons?.[300_000])
      .filter(usableHorizon);
    for (const label of COST_LABELS) {
      const costs = records
        .map((record) => record.result.costScenarios?.[label])
        .filter(isFiniteNumber);
      lines.push(
        `  cost ${label}: ${costs.length === 0 ? 'unavailable' : `N=${costs.length} mean=${format(mean(costs))}bps win=${format((costs.filter((value) => value > 0).length / costs.length) * 100)}%`}`,
      );
    }
    lines.push(`  300s coverage: ${horizon300.length}/${records.length}`);
  }

  lines.push('');
  lines.push('NEGATIVE CONTROLS');
  if (!input.archiveTrades) {
    lines.push(
      `RANDOM_SIDE (seed=${input.seed ?? 1}): unavailable - raw post-signal trajectory is not available.`,
    );
    lines.push('TIME_SHIFT (forward): unavailable - raw post-signal trajectory is not available.');
    lines.push(
      'Controls are intentionally not simulated by row reordering, return inversion, or timestamp shuffling.',
    );
  } else {
    const snapshots = signals.rows.filter(isSnapshot);
    const rng = seededRandom(input.seed ?? 1);
    const randomSide = snapshots.flatMap((signal) =>
      controlReturn({ ...signal, side: rng() < 0.5 ? 'LONG' : 'SHORT' }, input.archiveTrades!),
    );
    const timeShift = snapshots.flatMap((signal) => timeShiftReturn(signal, input.archiveTrades!));
    lines.push(
      `RANDOM_SIDE (seed=${input.seed ?? 1}): N=${randomSide.length} mean_300s=${randomSide.length ? format(mean(randomSide)) : 'N/A'}bps`,
    );
    lines.push(
      `TIME_SHIFT (forward 300s): N=${timeShift.length} mean_300s=${timeShift.length ? format(mean(timeShift)) : 'N/A'}bps`,
    );
    lines.push(
      'TIME_SHIFT is a return-only control: its entry is the first archived trade strictly after shifted T0; source entry prices and barrier levels are not copied.',
    );
  }

  return {
    text: `${lines.join('\n')}\n`,
    uniqueSignalCount: signals.rows.length,
    uniqueOutcomeCount: outcomes.rows.length,
    duplicateSignalRows: signals.duplicates,
    duplicateOutcomeRows: outcomes.duplicates,
  };
}

function modelRecordsFor(outcome: ProspectiveOutcomeRecord): ModelRecord[] {
  if (outcome.entryOutcomes) {
    return MODEL_ORDER.flatMap((model) => {
      const result = outcome.entryOutcomes?.[model];
      return result?.horizons ? [{ outcome, model, result }] : [];
    });
  }
  // Legacy records predate independent entry-model persistence and are explicitly SIGNAL_PRICE only.
  return [
    {
      outcome,
      model: 'SIGNAL_PRICE',
      result: {
        assumption: { model: 'SIGNAL_PRICE', entryPrice: null },
        horizons: outcome.horizons,
        barrierOutcome: outcome.barrierOutcome,
        dynamicExitOutcome: outcome.dynamicExitOutcome,
        grossBps: outcome.grossBps,
        costScenarios: outcome.costScenarios,
      },
    },
  ];
}

function missingModelCount(outcome: ProspectiveOutcomeRecord): number {
  if (!outcome.entryOutcomes) return 2;
  return MODEL_ORDER.filter((model) => !outcome.entryOutcomes?.[model]?.horizons).length;
}

function dedupe<T>(
  rows: readonly T[],
  id: (row: T) => string,
  select: (current: T, candidate: T) => T = (_current, candidate) => candidate,
): { rows: T[]; duplicates: number; invalid: number } {
  const selected = new Map<string, T>();
  let duplicates = 0;
  let invalid = 0;
  for (const row of rows) {
    const key = id(row);
    if (!key) {
      invalid++;
      continue;
    }
    const current = selected.get(key);
    if (current) {
      duplicates++;
      selected.set(key, select(current, row));
    } else {
      selected.set(key, row);
    }
  }
  return { rows: [...selected.values()], duplicates, invalid };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

function usableHorizon(value: HorizonOutcome | undefined): value is HorizonOutcome {
  return value !== undefined && value.tradeCount > 0 && value.priceAtHorizon !== null;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((sorted.length * p) / 100) - 1)] ?? Number.NaN;
}

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : 'N/A';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function book(
  row: Record<string, unknown> | ProspectiveOutcomeRecord,
): Record<string, unknown> | undefined {
  const value = row.book;
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSnapshot(
  row: Record<string, unknown>,
): row is Record<string, unknown> & ShadowSignalSnapshot {
  return (
    typeof row.symbol === 'string' &&
    (row.side === 'LONG' || row.side === 'SHORT') &&
    Number.isFinite(row.signalAtMs) &&
    Number.isFinite(row.marketPriceAtSignal) &&
    Number.isFinite(row.structuralStopPrice) &&
    Number.isFinite(row.destinationPrice)
  );
}

function controlReturn(
  signal: ShadowSignalSnapshot,
  archiveTrades: NonNullable<MicroBurstProspectiveAnalysisInput['archiveTrades']>,
): number[] {
  const horizon = 300_000;
  const outcome = computeHorizonOutcome(
    signal,
    signal.marketPriceAtSignal,
    [...archiveTrades(signal.symbol, signal.signalAtMs, signal.signalAtMs + horizon)],
    horizon,
  );
  return outcome.priceAtHorizon === null ? [] : [outcome.finalReturnBps];
}

function timeShiftReturn(
  signal: ShadowSignalSnapshot,
  archiveTrades: NonNullable<MicroBurstProspectiveAnalysisInput['archiveTrades']>,
): number[] {
  const horizon = 300_000;
  const shiftedAtMs = signal.signalAtMs + horizon;
  const trajectory = [...archiveTrades(signal.symbol, shiftedAtMs, shiftedAtMs + horizon)]
    .filter(
      (trade) => trade.eventTime > shiftedAtMs && Number.isFinite(trade.price) && trade.price > 0,
    )
    .sort((a, b) => a.eventTime - b.eventTime || a.receivedAtMs - b.receivedAtMs);
  const entry = trajectory[0];
  if (!entry) return [];
  // Return-only control: reconstruct entry from post-shift market data, not the source snapshot.
  const shiftedSignal = { ...signal, signalAtMs: shiftedAtMs, marketPriceAtSignal: entry.price };
  const outcome = computeHorizonOutcome(shiftedSignal, entry.price, trajectory, horizon);
  return outcome.priceAtHorizon === null ? [] : [outcome.finalReturnBps];
}

function seededRandom(seed: number): () => number {
  let state = (Number.isFinite(seed) ? seed : 1) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
