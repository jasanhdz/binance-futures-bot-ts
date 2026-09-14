import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import {
  assertStrategyDecisionEvidenceV2,
  type StrategyDecisionEvidenceV2,
} from '../../core/blackbox/StrategyDecisionBlackBox';
import {
  replayMicroBurstExact,
  type MicroBurstExactReplay,
} from '../../strategies/micro-burst/domain/MicroBurstExactReplay';
import type { MicroBurstEntryDecision } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import { MICRO_RESEARCH_PATTERNS, MicroBurstPatternEpisodes } from './MicroBurstPatternEpisodes';
import {
  compileOfflineReaction,
  MicroBurstPatternEvaluator,
  REACTION_SOURCE_PATH,
  RESEARCH_ROOT,
} from './MicroBurstPatternEvaluator';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const count = (map: Record<string, number>, key: string): void => {
  map[key] = (map[key] ?? 0) + 1;
};
const intersection = (a: Set<string>, b: Set<string>): number =>
  [...a].filter((k) => b.has(k)).length;
const stripNewDiagnostics = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === 'triggerInputs' ? undefined : item)));

/** Exact validator must run BEFORE decoding/using this record. No timestamp fallback. */
export function decodeValidatedPatternReplay(
  wire: unknown,
  commit: string,
): {
  replay: MicroBurstExactReplay;
  current: MicroBurstEntryDecision;
} {
  const current = replayMicroBurstExact(wire, commit);
  const replay = JSON.parse(JSON.stringify(wire), (_key, item) =>
    item && typeof item === 'object' && Object.keys(item).length === 1 && 'microNumber' in item
      ? Number(item.microNumber)
      : item,
  ) as MicroBurstExactReplay;
  if (
    ![
      replay.context.observedAtMs,
      replay.context.exchangeObservedAtMs,
      replay.context.timestamp,
    ].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
  )
    throw new Error('PATTERN_EXPLICIT_FINITE_CLOCKS_REQUIRED');
  return { replay, current };
}

export function historicalDecisionAgrees(
  record: StrategyDecisionEvidenceV2,
  decision: MicroBurstEntryDecision,
): boolean {
  return (
    record.decision === decision.action &&
    record.reason === decision.reason &&
    record.side === decision.side &&
    record.confidence ===
      (Number.isFinite(decision.confirmationStrength) ? decision.confirmationStrength : null) &&
    record.destinationPrice === decision.targetPrice &&
    record.structuralInvalidation === decision.stopInvalidationPrice &&
    Object.entries(decision.diagnostics).every(([key, value]) =>
      isDeepStrictEqual(
        stripNewDiagnostics(record.diagnostics[key] ?? null),
        stripNewDiagnostics(value ?? null),
      ),
    )
  );
}

/** Read-only rotated-file experiment; refuses active paths and changed files. */
export function compareMicroBurstPatterns(inputPath: string): Record<string, unknown> {
  const file = resolve(inputPath);
  if (!/^decisions-v2\.\d{4}-.*\.\d+\.jsonl\.gz$/.test(basename(file)))
    throw new Error('PATTERN_ROTATED_GZIP_REQUIRED');
  const before = statSync(file);
  const compressed = readFileSync(file);
  const hash = sha256(compressed);
  const text = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8');
  const counts: Record<string, number> = {
    lines: 0,
    parsed: 0,
    malformed: 0,
    micro: 0,
    missingReplay: 0,
    duplicateDecisionIds: 0,
    duplicateInputs: 0,
    incompatible: 0,
    validated: 0,
    historicalAgreement: 0,
    historicalMismatch: 0,
    sourceParity: 0,
    sourceMismatch: 0,
    patternInputErrors: 0,
    currentEntryEvaluations: 0,
    jsonNullNonfiniteConfidence: 0,
  };
  const exclusions: Record<string, number> = {};
  const examples: Record<string, unknown[]> = {};
  const addExample = (key: string, value: unknown): void => {
    const list = (examples[key] ??= []);
    if (list.length < 3) list.push(value);
  };
  const evaluator = new MicroBurstPatternEvaluator();
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: RESEARCH_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '' },
    });
  const revisions = new Map<string, ReturnType<typeof compileOfflineReaction>>();
  const revisionEvidence: Record<string, unknown> = {};
  const checkRevision = (commit: string): ReturnType<typeof compileOfflineReaction> => {
    const cached = revisions.get(commit);
    if (cached) return cached;
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('PATTERN_INVALID_COMMIT');
    const dependencies = [
      'MicroBurstInputFreshness',
      'MicroBurstBtcContext',
      'MicroBurstEntryPolicy',
      'MicroBurstIdentity',
      'MicroBurstUnits',
      'MicroBurstTypes',
      'MicroBurstLeveragePolicy',
      'MicroBurstExactReplay',
    ].map((name) => `src/strategies/micro-burst/domain/${name}.ts`);
    dependencies.push(
      'src/core/strategy/StrategyIdentity.ts',
      'src/core/types.ts',
      'src/core/blackbox/BoundedObservationQueue.ts',
    );
    const dependencyDiff = git(['diff', commit, '--', ...dependencies]);
    if (dependencyDiff.trim()) throw new Error('PATTERN_HISTORICAL_DEPENDENCY_DIFF');
    const historicalSource = git(['show', `${commit}:${REACTION_SOURCE_PATH}`]);
    const diff = git(['diff', commit, '--', REACTION_SOURCE_PATH]);
    revisionEvidence[commit] = {
      dependencyDiffEmpty: true,
      historicalSourceSha256: sha256(historicalSource),
      evaluatorDiff: diff,
    };
    const historical = compileOfflineReaction(historicalSource);
    revisions.set(commit, historical);
    return historical;
  };
  const rows: {
    line: number;
    record: StrategyDecisionEvidenceV2;
    replay: MicroBurstExactReplay;
    current: MicroBurstEntryDecision;
  }[] = [];
  const ids = new Map<string, string>();
  const inputs = new Set<string>();
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    counts.lines++;
    let record: StrategyDecisionEvidenceV2;
    try {
      record = JSON.parse(line) as StrategyDecisionEvidenceV2;
      counts.parsed++;
    } catch {
      counts.malformed++;
      continue;
    }
    if (record?.strategy?.strategyId !== 'MICRO_BURST') continue;
    counts.micro++;
    const wire = record.diagnostics?.strategyInputReplay;
    if (!wire) {
      counts.missingReplay++;
      continue;
    }
    try {
      assertStrategyDecisionEvidenceV2(record);
      if (typeof record.decisionId !== 'string' || !record.decisionId)
        throw new Error('PATTERN_DECISION_ID_REQUIRED');
      const recordHash = sha256(line);
      if (ids.has(record.decisionId)) {
        if (ids.get(record.decisionId) !== recordHash)
          throw new Error('PATTERN_CONFLICTING_DUPLICATE');
        counts.duplicateDecisionIds++;
        continue;
      }
      ids.set(record.decisionId, recordHash);
      const commit = record.strategy.codeCommitSha;
      const historical = checkRevision(commit);
      const { replay, current } = decodeValidatedPatternReplay(wire, commit);
      if (
        record.symbol !== replay.context.symbol ||
        record.strategyTimestampMs !== replay.context.timestamp
      )
        throw new Error('PATTERN_ENVELOPE_INPUT_MISMATCH');
      const old = historical(
        replay.context,
        replay.config,
        replay.context.executionBook,
        replay.context.observedAtMs!,
        replay.context.exchangeObservedAtMs!,
      );
      // BlackBox serializes envelope numbers with ordinary JSON, whereas exact input
      // uses tagged NaN. Count this known representation loss, do not fabricate a value.
      if (record.confidence === null && !Number.isFinite(old.confirmationStrength))
        counts.jsonNullNonfiniteConfidence++;
      const sourceEqual = isDeepStrictEqual(stripNewDiagnostics(old), stripNewDiagnostics(current));
      counts[sourceEqual ? 'sourceParity' : 'sourceMismatch']++;
      const agrees = historicalDecisionAgrees(record, old);
      counts[agrees ? 'historicalAgreement' : 'historicalMismatch']++;
      if (!agrees || !sourceEqual)
        addExample('baselineMismatch', {
          line: index + 1,
          decisionId: record.decisionId,
          historical: record.decision,
          historicalReason: record.reason,
          replay: old.action,
          replayReason: old.reason,
          sourceEqual,
          historicalConfidence: record.confidence,
          replayConfidence: old.confirmationStrength,
          diagnosticDifferences: Object.entries(old.diagnostics)
            .filter(
              ([key, value]) =>
                !isDeepStrictEqual(
                  stripNewDiagnostics(record.diagnostics[key] ?? null),
                  stripNewDiagnostics(value ?? null),
                ),
            )
            .map(([key, value]) => ({ key, recorded: record.diagnostics[key], replayed: value })),
        });
      const inputHash = sha256(JSON.stringify(wire));
      if (inputs.has(inputHash)) {
        counts.duplicateInputs++;
        continue;
      }
      inputs.add(inputHash);
      counts.validated++;
      rows.push({ line: index + 1, record, replay, current });
    } catch (error) {
      counts.incompatible++;
      count(exclusions, String(error));
      addExample('incompatible', { line: index + 1, error: String(error) });
    }
  }
  // Never silently use a mismatched baseline to report counterfactual improvements.
  const baselineVerified =
    counts.validated > 0 && counts.historicalMismatch === 0 && counts.sourceMismatch === 0;
  const tracker = new MicroBurstPatternEpisodes();
  const currentKeys = new Set<string>();
  const currentEpisodes = new Set<string>();
  const observedCandles = new Set<string>();
  const currentReasons: Record<string, number> = {};
  const patternKeys = Object.fromEntries(
    MICRO_RESEARCH_PATTERNS.map((p) => [p, new Set<string>()]),
  );
  const patternEpisodes = Object.fromEntries(
    MICRO_RESEARCH_PATTERNS.map((p) => [p, new Set<string>()]),
  );
  const patternEvaluations: Record<string, number> = {};
  const patternRejections: Record<string, number> = {};
  const evaluationOverlap: Record<string, number> = {};
  const configBySymbol = new Map<string, string>();
  const quarantined = new Set<string>();
  const firstPatternObservationBySymbol = new Map<string, number>();
  const emittedConfirmationIds = new Set<string>();
  const evaluationLedger: Record<string, unknown>[] = [];
  const currentLedger: {
    line: number;
    decisionId: string;
    symbol: string;
    side: string;
    closeTime: number;
    episodeId: unknown;
  }[] = [];
  if (baselineVerified)
    for (const row of rows.sort(
      (a, b) => a.replay.context.observedAtMs! - b.replay.context.observedAtMs! || a.line - b.line,
    )) {
      const { replay, current, record, line } = row;
      const ctx = replay.context;
      const latest = ctx.candles.candles1m.filter((c) => c.closeTime <= ctx.timestamp).slice(-1)[0];
      const key = (side: string): string => `${ctx.symbol}|${side}|${latest?.closeTime}`;
      if (latest) observedCandles.add(`${ctx.symbol}|${latest.closeTime}`);
      count(currentReasons, current.reason);
      if (current.action === 'ENTRY_INTENT') {
        counts.currentEntryEvaluations++;
        currentLedger.push({
          line,
          decisionId: record.decisionId,
          symbol: ctx.symbol,
          side: current.side!,
          closeTime: latest!.closeTime,
          episodeId: current.diagnostics.episodeId,
        });
        currentKeys.add(key(current.side!));
        if (typeof current.diagnostics.episodeId === 'string')
          currentEpisodes.add(current.diagnostics.episodeId);
        addExample('CURRENT', {
          line,
          decisionId: record.decisionId,
          candleKey: key(current.side!),
          episodeId: current.diagnostics.episodeId,
          executablePrice: current.diagnostics.executablePrice,
        });
      }
      try {
        if (quarantined.has(ctx.symbol))
          throw new Error('PATTERN_SYMBOL_QUARANTINED_AFTER_INPUT_ERROR');
        const configHash = sha256(JSON.stringify(replay.config));
        if (configBySymbol.has(ctx.symbol) && configBySymbol.get(ctx.symbol) !== configHash)
          throw new Error('PATTERN_CONFIG_CHANGED_WITHIN_SAMPLE');
        configBySymbol.set(ctx.symbol, configHash);
        if (!firstPatternObservationBySymbol.has(ctx.symbol))
          firstPatternObservationBySymbol.set(ctx.symbol, ctx.observedAtMs!);
        const confirmations = tracker.advance(
          ctx,
          replay.config.srClusterToleranceBps,
          ctx.observedAtMs!,
          ctx.exchangeObservedAtMs!,
        );
        counts.patternProcessedEvaluations = (counts.patternProcessedEvaluations ?? 0) + 1;
        const entered = new Set<string>();
        for (const episode of confirmations) {
          emittedConfirmationIds.add(episode.id);
          count(patternEvaluations, episode.pattern);
          const decision = evaluator.evaluateConfirmation(
            episode,
            ctx,
            replay.config,
            ctx.executionBook,
            ctx.observedAtMs!,
            ctx.exchangeObservedAtMs!,
          );
          const sideDiagnostics = (
            decision.diagnostics.sides as Record<string, { reason?: string }> | undefined
          )?.[episode.side];
          const reason =
            decision.action === 'ENTRY_INTENT'
              ? 'ENTRY_INTENT'
              : (sideDiagnostics?.reason ?? decision.reason);
          count(patternRejections, `${episode.pattern}:${reason}`);
          evaluationLedger.push({
            line,
            decisionId: record.decisionId,
            episodeId: episode.id,
            pattern: episode.pattern,
            side: episode.side,
            action: decision.action,
            reason,
            evaluatedAtMs: ctx.observedAtMs,
            exchangeObservedAtMs: ctx.exchangeObservedAtMs,
            confirmedAtMs: episode.confirmedAtMs,
            executablePrice:
              episode.side === 'LONG'
                ? ctx.executionBook?.askDepth[0]?.price
                : ctx.executionBook?.bidDepth[0]?.price,
            overlapsCurrentAtEvaluation:
              current.action === 'ENTRY_INTENT' && current.side === episode.side,
          });
          if (decision.action === 'ENTRY_INTENT') {
            patternKeys[episode.pattern].add(key(episode.side));
            patternEpisodes[episode.pattern].add(episode.id);
            entered.add(episode.pattern);
            if (current.action === 'ENTRY_INTENT' && current.side === episode.side)
              count(evaluationOverlap, `CURRENT:${episode.pattern}`);
          }
          addExample(`${episode.pattern}:${reason}`, {
            line,
            decisionId: record.decisionId,
            candleKey: key(episode.side),
            episode: structuredClone(episode),
            reason,
            evaluatedAtMs: ctx.observedAtMs,
            exchangeObservedAtMs: ctx.exchangeObservedAtMs,
            executableBook: ctx.executionBook
              ? {
                  observedAtMs: ctx.executionBook.observedAtMs,
                  status: ctx.executionBook.status,
                  bid: ctx.executionBook.bidDepth[0],
                  ask: ctx.executionBook.askDepth[0],
                }
              : null,
            confirmationCandle: latest,
            initiationCandle: ctx.candles.candles1m.find((c) => c.openTime === episode.startedAtMs),
            recoveryCandle: ctx.candles.candles1m.find((c) => c.closeTime === episode.recoveryAtMs),
            diagnostics: decision.diagnostics,
          });
        }
        if (MICRO_RESEARCH_PATTERNS.every((p) => entered.has(p)))
          count(evaluationOverlap, 'MULTI_CANDLE_RECLAIM:CONFIRMED_ZONE_DEFENSE');
      } catch (error) {
        counts.patternInputErrors++;
        quarantined.add(ctx.symbol);
        count(exclusions, String(error));
        addExample('patternInputError', {
          line,
          decisionId: record.decisionId,
          symbol: ctx.symbol,
          error: String(error),
          evidence: (error as { evidence?: unknown }).evidence,
        });
      }
    }
  const episodeCounts: Record<string, number> = {};
  for (const episode of tracker.episodes) {
    count(episodeCounts, `${episode.pattern}:STARTED`);
    count(episodeCounts, `${episode.pattern}:FINAL_${episode.status}`);
    addExample(`episode:${episode.pattern}:${episode.status}`, episode);
  }
  const after = statSync(file);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino ||
    sha256(readFileSync(file)) !== hash
  )
    throw new Error('PATTERN_INPUT_FILE_CHANGED');
  return {
    mode: 'OFFLINE_PATTERN_ENTRY_COMPARISON_NO_PNL',
    provenance: {
      file,
      compressedSha256: hash,
      compressedBytes: compressed.length,
      uncompressedBytes: Buffer.byteLength(text),
      currentSourceSha256: evaluator.sourceSha256,
      toolingSourceSha256: Object.fromEntries(
        [
          'MicroBurstPatternEpisodes',
          'MicroBurstPatternEvaluator',
          'MicroBurstPatternComparison',
        ].map((name) => [
          name,
          sha256(readFileSync(resolve(RESEARCH_ROOT, `src/tooling/micro-burst/${name}.ts`))),
        ]),
      ),
      baselineVerified,
      checkedOutCommit: git(['rev-parse', 'HEAD']).trim(),
      revisionEvidence,
      configSha256BySymbol: Object.fromEntries(configBySymbol),
      observationRange: rows.length
        ? {
            localMinMs: Math.min(...rows.map((row) => row.replay.context.observedAtMs!)),
            localMaxMs: Math.max(...rows.map((row) => row.replay.context.observedAtMs!)),
            exchangeSnapshotMinMs: Math.min(...rows.map((row) => row.replay.context.timestamp)),
            exchangeSnapshotMaxMs: Math.max(...rows.map((row) => row.replay.context.timestamp)),
          }
        : null,
    },
    counts,
    exclusions,
    opportunityUnit:
      'UNIQUE_SYMBOL_SIDE_CLOSED_CANDLE; CURRENT evaluated on all unique inputs; new patterns only on first observed confirmation',
    totals: baselineVerified
      ? {
          CURRENT: {
            entryOpportunities: currentKeys.size,
            independentEntryEpisodeIds: currentEpisodes.size,
          },
          ...Object.fromEntries(
            MICRO_RESEARCH_PATTERNS.map((p) => [
              `CURRENT+${p}`,
              {
                entryOpportunities: new Set([...currentKeys, ...patternKeys[p]]).size,
                additionalEntryOpportunities: [...patternKeys[p]].filter((k) => !currentKeys.has(k))
                  .length,
                patternEntryOpportunities: patternKeys[p].size,
                patternIndependentEntryEpisodeIds: patternEpisodes[p].size,
                overlapWithCurrentCandles: intersection(currentKeys, patternKeys[p]),
              },
            ]),
          ),
        }
      : null,
    episodeCounts,
    patternEvaluations,
    patternRejections,
    evaluationOverlap,
    currentReasons,
    repeatedDecisionAccounting: {
      uniqueSymbolClosedCandles: observedCandles.size,
      evaluationsBeyondFirstPerCandle: baselineVerified ? rows.length - observedCandles.size : null,
      historicalWarmupConfirmationsNotEvaluated: tracker.episodes.filter(
        (e) =>
          e.status === 'CONFIRMED' &&
          !emittedConfirmationIds.has(e.id) &&
          e.events[e.events.length - 1].observedAtMs ===
            firstPatternObservationBySymbol.get(e.symbol),
      ).length,
      laterHistoricalBackfillConfirmationsNotEvaluated: tracker.episodes.filter(
        (e) =>
          e.status === 'CONFIRMED' &&
          !emittedConfirmationIds.has(e.id) &&
          e.events[e.events.length - 1].observedAtMs !==
            firstPatternObservationBySymbol.get(e.symbol),
      ).length,
      latestConfirmationsObservedAtInitialSymbolObservation: tracker.episodes.filter(
        (e) =>
          emittedConfirmationIds.has(e.id) &&
          e.events[e.events.length - 1].observedAtMs ===
            firstPatternObservationBySymbol.get(e.symbol),
      ).length,
      latestConfirmationsObservedAfterInitialSymbolObservation: tracker.episodes.filter(
        (e) =>
          emittedConfirmationIds.has(e.id) &&
          e.events[e.events.length - 1].observedAtMs !==
            firstPatternObservationBySymbol.get(e.symbol),
      ).length,
    },
    episodeLedger: tracker.episodes,
    evaluationLedger,
    currentEntryLedger: currentLedger,
    episodeIntervalOverlapWithCurrent: Object.fromEntries(
      MICRO_RESEARCH_PATTERNS.map((pattern) => [
        pattern,
        tracker.episodes.filter(
          (e) =>
            e.pattern === pattern &&
            currentLedger.some(
              (c) =>
                c.symbol === e.symbol &&
                c.side === e.side &&
                c.closeTime >= e.initiationClosedAtMs &&
                c.closeTime <=
                  (e.confirmedAtMs ??
                    e.invalidatedAtMs ??
                    e.expiredAtMs ??
                    e.initiationClosedAtMs + 180_000),
            ),
        ).length,
      ]),
    ),
    newPatternEntryCandleOverlap: intersection(
      patternKeys[MICRO_RESEARCH_PATTERNS[0]],
      patternKeys[MICRO_RESEARCH_PATTERNS[1]],
    ),
    newPatternEpisodeIntervalOverlapPairs: tracker.episodes
      .filter((a) => a.pattern === MICRO_RESEARCH_PATTERNS[0])
      .flatMap((a) =>
        tracker.episodes
          .filter(
            (b) =>
              b.pattern === MICRO_RESEARCH_PATTERNS[1] &&
              a.symbol === b.symbol &&
              a.side === b.side &&
              a.startedAtMs <=
                (b.confirmedAtMs ??
                  b.invalidatedAtMs ??
                  b.expiredAtMs ??
                  b.initiationClosedAtMs + 180_000) &&
              b.startedAtMs <=
                (a.confirmedAtMs ??
                  a.invalidatedAtMs ??
                  a.expiredAtMs ??
                  a.initiationClosedAtMs + 180_000),
          )
          .map((b) => ({ multi: a.id, zone: b.id })),
      ),
    sameInitiationEpisodeOverlap: tracker.episodes.filter(
      (a) =>
        a.pattern === MICRO_RESEARCH_PATTERNS[0] &&
        tracker.episodes.some(
          (b) =>
            b.pattern === MICRO_RESEARCH_PATTERNS[1] &&
            a.symbol === b.symbol &&
            a.side === b.side &&
            a.startedAtMs === b.startedAtMs &&
            a.level.price === b.level.price &&
            a.level.type === b.level.type &&
            a.level.availableAtMs === b.level.availableAtMs &&
            a.levelVersionAsOfMs === b.levelVersionAsOfMs,
        ),
    ).length,
    examples,
    limitations: [
      'Entry intents/opportunities are not fills, orders, admission approval or PnL.',
      'Baseline envelope nonfinite confidence becomes null under BlackBox JSON serialization; these occurrences are counted explicitly.',
      'Pattern input errors quarantine that symbol for the remainder of this sample; CURRENT totals still cover all validated baseline inputs.',
      'Execution admission, account sizing, portfolio risk and duplicate-signal routing are outside exact entry replay and are not asserted to pass.',
      'Sample warm-up can reconstruct episodes only from included causal candle/level history; terminal state before that history is unknown.',
      'Native support LONG / resistance SHORT patterns; CURRENT role-reversal logic remains available in the union.',
      'Holding favorable side means confirmation CLOSE remains favorable of center; wick penetration is not an extra rejection.',
      'At most one active episode per symbol/side/pattern; nearest touching eligible level wins at initiation.',
      'Confirmation attempts consume the candle even when downstream freshness or economics rejects; no retrospective retry at a better quote.',
      'Future economics must use actual Micro intelligent exit with an independent protective stop; destination geometry is not a fixed-TP mandate.',
    ],
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3)
      throw new Error('USAGE: MicroBurstPatternComparison.ts ROTATED_JSONL_GZ');
    process.stdout.write(
      `${JSON.stringify(compareMicroBurstPatterns(process.argv[2]), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
