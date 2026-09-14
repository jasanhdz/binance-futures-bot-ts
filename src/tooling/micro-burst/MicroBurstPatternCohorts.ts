import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { RESEARCH_ROOT } from './MicroBurstPatternEvaluator';

/** Explicit independent cohorts: never add their warm-up/episode counts as one continuous run. */
export function summarizePatternCohorts(reports: Record<string, any>[]): Record<string, unknown> {
  const hashes = new Set(
    reports.flatMap((report) => Object.values(report.provenance.configSha256BySymbol ?? {})),
  );
  const sources = new Set(reports.map((report) => report.provenance.compressedSha256));
  if (sources.size !== reports.length) throw new Error('COHORT_DUPLICATE_SOURCE');
  if (
    hashes.size !== 1 ||
    reports.some(
      (report) =>
        !report.provenance.baselineVerified ||
        Object.keys(report.provenance.configSha256BySymbol ?? {}).length === 0,
    )
  )
    throw new Error('COHORT_BASELINE_OR_THRESHOLD_INCOMPATIBLE');
  return {
    mode: 'EXPLICITLY_SEPARATE_ROTATED_FILE_COHORTS_NO_PNL',
    stateBoundary:
      'Each file is an independent cohort with its own historical warm-up and quarantine. No combined episode or entry total is asserted.',
    identicalConfigSha256: [...hashes][0],
    cohortTable: reports.map((report) => ({
      file: report.provenance.file,
      sha256: report.provenance.compressedSha256,
      observationRange: report.provenance.observationRange,
      validated: report.counts.validated,
      historicalMismatch: report.counts.historicalMismatch,
      sourceMismatch: report.counts.sourceMismatch,
      incompatible: report.counts.incompatible,
      patternProcessed: report.counts.patternProcessedEvaluations,
      patternExcluded: report.counts.patternInputErrors,
      exclusions: report.exclusions,
      entryOpportunities: Object.fromEntries(
        Object.entries(report.totals).map(([variant, total]) => [
          variant,
          (total as { entryOpportunities: number }).entryOpportunities,
        ]),
      ),
      episodeCounts: report.episodeCounts,
      patternEvaluations: report.patternEvaluations,
      patternRejections: report.patternRejections,
      repeatedDecisionAccounting: report.repeatedDecisionAccounting,
    })),
    summaries: reports.map((report) => ({
      provenance: report.provenance,
      counts: report.counts,
      exclusions: report.exclusions,
      totals: report.totals,
      episodeCounts: report.episodeCounts,
      repeatedDecisionAccounting: report.repeatedDecisionAccounting,
      patternEvaluations: report.patternEvaluations,
      patternRejections: report.patternRejections,
      evaluationLedger: report.evaluationLedger,
      crossPatternIntervalOverlapPairs: report.newPatternEpisodeIntervalOverlapPairs.length,
      newPatternEntryCandleOverlap: report.newPatternEntryCandleOverlap,
      examples: report.examples,
    })),
  };
}

if (require.main === module) {
  try {
    const files = process.argv.slice(2);
    if (files.length < 2)
      throw new Error('USAGE: MicroBurstPatternCohorts.ts ROTATED_JSONL_GZ ROTATED_JSONL_GZ [...]');
    // One process per cohort bounds retained replay memory and makes reset boundaries explicit.
    const reports = files.map((file) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            '-r',
            'ts-node/register',
            resolve(RESEARCH_ROOT, 'src/tooling/micro-burst/MicroBurstPatternComparison.ts'),
            resolve(file),
          ],
          { cwd: RESEARCH_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
        ),
      ),
    );
    process.stdout.write(`${JSON.stringify(summarizePatternCohorts(reports), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
