import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { scanStableJsonl, canonicalEvidence } from './MicroBurstInputForensics';
import {
  replayMicroBurstExact,
  type MicroBurstExactReplay,
} from '../../strategies/micro-burst/domain/MicroBurstExactReplay';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export function compareOriginalDecision(
  record: StrategyDecisionEvidenceV2,
): Record<string, unknown> {
  const replay = record.diagnostics.strategyInputReplay as MicroBurstExactReplay | undefined;
  if (!replay) return { status: 'MISSING_ORIGINAL_INPUT', decisionId: record.decisionId };
  try {
    const actual = replayMicroBurstExact(replay, replay.codeCommitSha);
    const stored = {
      decision: record.decision,
      side: record.side,
      reason: record.reason,
      confidence: record.confidence,
      stop: record.structuralInvalidation,
      target: record.destinationPrice,
      selectedDefense: record.diagnostics.selectedDefense,
      selectedTarget: record.diagnostics.selectedTarget,
    };
    const computed = {
      decision: actual.action,
      side: actual.side,
      reason: actual.reason,
      confidence: actual.confirmationStrength,
      stop: actual.stopInvalidationPrice,
      target: actual.targetPrice,
      selectedDefense: actual.diagnostics.selectedDefense,
      selectedTarget: actual.diagnostics.selectedTarget,
    };
    const differences = Object.keys(stored).filter(
      (key) =>
        canonicalEvidence(stored[key as keyof typeof stored]) !==
        canonicalEvidence(computed[key as keyof typeof computed]),
    );
    return {
      status: differences.length ? 'MISMATCH' : 'MATCH_WITH_CURRENT_EVALUATOR',
      differences,
      decisionId: record.decisionId,
      symbol: record.symbol,
      receivedAtMs: record.evaluatedAtReceivedMs,
      stored,
      computed,
      inputSha256: digest(canonicalEvidence(replay)),
      configSha256: digest(canonicalEvidence(replay.config)),
      storedConfigHash: record.strategy.configHash,
      reportedHistoricalCommit: replay.codeCommitSha,
      historicalCodeIdentity: 'NOT_CERTIFIED_BY_COMMIT_TAG_ALONE',
      sourcesPresent: replay.sourcesPresent,
      candleCounts: Object.fromEntries(
        Object.entries(replay.context.candles).map(([key, candles]) => [key, candles.length]),
      ),
      btcContextPresent: replay.context.btcContext !== null,
      rawWarmupCoverage: 'NOT_CERTIFIED',
    };
  } catch (error) {
    return {
      status: 'REPLAY_REJECTED',
      decisionId: record.decisionId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Inventory the bounded archive period and replay actual recorded inputs, never manufacture an entry. */
export async function auditRealEpisodeAvailability(
  databasePath: string,
  decisionFiles: readonly string[],
  fromMs: number,
  throughMs: number,
): Promise<Record<string, unknown>> {
  if (![fromMs, throughMs].every(Number.isFinite) || throughMs <= fromMs || !decisionFiles.length)
    throw new Error('INVALID_REAL_EPISODE_AUDIT_RANGE');
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const inventory = db
      .prepare(
        'SELECT symbol,data_type,count(*) segments,sum(record_count) records,min(first_event_time_ms) firstMs,max(last_event_time_ms) lastMs FROM market_data_segments WHERE first_event_time_ms <= ? AND last_event_time_ms >= ? GROUP BY symbol,data_type',
      )
      .all(throughMs, fromMs);
    const signals = db
      .prepare(
        'SELECT signal_id,symbol,signal_at_ms,episode_id FROM micro_burst_signals WHERE signal_at_ms BETWEEN ? AND ?',
      )
      .all(fromMs, throughMs);
    const sources: Record<string, unknown>[] = [];
    const counts: Record<string, number> = {};
    const accepted: Record<string, unknown>[] = [];
    const negativeControls: Record<string, unknown>[] = [];
    const sampled = new Set<string>();
    let first: number | null = null,
      last: number | null = null;
    let malformed = 0;
    for (const file of decisionFiles) {
      const source = await scanStableJsonl(file, (value, line) => {
        const r = value as StrategyDecisionEvidenceV2;
        if (
          r.strategy?.strategyId !== 'MICRO_BURST' ||
          !Number.isFinite(r.evaluatedAtReceivedMs) ||
          r.evaluatedAtReceivedMs < fromMs ||
          r.evaluatedAtReceivedMs > throughMs
        )
          return;
        first = first === null ? r.evaluatedAtReceivedMs : Math.min(first, r.evaluatedAtReceivedMs);
        last = last === null ? r.evaluatedAtReceivedMs : Math.max(last, r.evaluatedAtReceivedMs);
        counts[r.decision] = (counts[r.decision] ?? 0) + 1;
        if (r.decision === 'ENTRY_INTENT')
          accepted.push({ file, line, ...compareOriginalDecision(r) });
        else if (!sampled.has(r.symbol)) {
          sampled.add(r.symbol);
          negativeControls.push({ file, line, ...compareOriginalDecision(r) });
        }
      });
      malformed += Number(source.malformed);
      sources.push(source);
    }
    const policy = resolve('src/strategies/micro-burst/domain/MicroBurstReactionEntryPolicy.ts');
    return {
      authority: 'READ_ONLY_EVIDENCE_INVENTORY',
      databasePath: resolve(databasePath),
      fromMs,
      throughMs,
      inventory,
      signals,
      sources,
      malformed,
      counts,
      firstDecisionAtMs: first,
      lastDecisionAtMs: last,
      policySourceSha256: digest(readFileSync(policy)),
      fullEvaluatorDependencyIdentity: 'NOT_CERTIFIED',
      accepted,
      negativeControls,
      executableEpisodeStatus: accepted.length
        ? 'REQUIRES_WARMUP_PATH_AND_EXECUTION_CERTIFICATION'
        : 'NO_ENTRY_EPISODE_IN_SCANNED_RECORDS',
      datasetCompleteness: 'BOUNDED_FILE_SELECTION_NOT_GLOBAL_COMPLETENESS_PROOF',
      economicComparison: 'NOT_PRODUCED',
      sizingComparison: 'EQUAL_MONETARY_RISK_NOT_LIVE_MARGIN_FRACTION',
      stopModel: 'IMMEDIATE_PROTECTION_NOT_CERTIFIED_FOR_ECONOMIC_CONCLUSIONS',
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const [databasePath, directory, prefix, from, through] = process.argv.slice(2);
  if (!databasePath || !directory || !prefix || !from || !through)
    throw new Error('USAGE: <sqlite> <decision-directory> <filename-prefix> <fromMs> <throughMs>');
  const files = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl.gz'))
    .sort()
    .map((name) => join(directory, name));
  auditRealEpisodeAvailability(databasePath, files, Number(from), Number(through)).then(
    (report) => console.log(JSON.stringify(report, null, 2)),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
