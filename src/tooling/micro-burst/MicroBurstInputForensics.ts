import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Candle, Side } from '../../core/types';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import type { MicroBurstExactReplay } from '../../strategies/micro-burst/domain/MicroBurstExactReplay';
import { decodeValidatedPatternReplay } from './MicroBurstPatternComparison';
import { RESEARCH_ROOT } from './MicroBurstPatternEvaluator';

type JsonObject = Record<string, unknown>;
export function canonicalEvidence(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) return { nonfinite: String(item) };
    if (item && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    return item;
  });
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const evidenceHash = (value: unknown): string => hash(canonicalEvidence(value));

/** Hash property-order-independent numerical content separately from its JSON representation. */
export function candleFingerprint(candle: Candle): JsonObject {
  const fields = [
    'openTime',
    'closeTime',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'buyVolume',
  ] as const;
  return {
    jsonSha256: hash(JSON.stringify(candle)),
    canonicalSha256: evidenceHash(candle),
    numericalSha256: evidenceHash(fields.map((key) => candle[key] ?? null)),
    candle,
  };
}

/** Stream the complete file, record compressed bytes' hash and reject concurrent changes. */
export async function scanStableJsonl(
  file: string,
  visit: (value: unknown, line: number) => void,
): Promise<JsonObject> {
  const before = statSync(file);
  const digest = createHash('sha256');
  const input = createReadStream(file);
  input.on('data', (chunk) => digest.update(chunk));
  const decoded = file.endsWith('.gz') ? input.pipe(createGunzip()) : input;
  input.on('error', (error) => decoded.destroy(error));
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  let line = 0;
  let malformed = 0;
  for await (const text of lines) {
    line++;
    if (!text.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      malformed++;
      continue;
    }
    visit(value, line);
  }
  const after = statSync(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('FORENSIC_SOURCE_CHANGED');
  return {
    file: resolve(file),
    sha256: digest.digest('hex'),
    bytes: before.size,
    lines: line,
    malformed,
    stability: 'UNCHANGED_INODE_SIZE_MTIME_DURING_COMPLETE_HASHED_READ',
    rotated: file.endsWith('.gz'),
  };
}

export function btcTimeline(replay: MicroBurstExactReplay): JsonObject {
  const ctx = replay.context;
  const timing = ctx.inputSources?.timing;
  const btc = ctx.btcContext;
  const clock = ctx.clockReference;
  const difference = (a: unknown, b: unknown): number | null =>
    typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)
      ? a - b
      : null;
  return {
    btc,
    eventTimestampMeaning: 'LATEST_CLOSED_BTC_1M_CANDLE_CLOSE_NOT_WEBSOCKET_EVENT_OR_POLL_TIME',
    receivedTimestampMeaning:
      btc?.receivedAtMs === undefined
        ? 'UNKNOWN'
        : 'PROVIDER_POLL_COMPLETION_LOCAL_TIME_NOT_EXCHANGE_PACKET_RECEIPT',
    btcSourcePacketReceivedAtMs: null,
    btcPollRequestedAtMs: null,
    btcCacheOriginalFetchAtMs: null,
    snapshotAtExchangeMs: ctx.timestamp,
    decisionAtLocalMs: ctx.observedAtMs,
    decisionAtExchangeUpperBoundMs: ctx.exchangeObservedAtMs,
    clockReference: clock,
    builderTiming: timing,
    freshnessLimitMs: replay.config.btcFreshnessMaxMs,
    eventAgeAtSnapshotMs: difference(ctx.timestamp, btc?.observedAtMs),
    eventAgeAtDecisionUpperBoundMs: difference(ctx.exchangeObservedAtMs, btc?.observedAtMs),
    eventAgeAtContextBuiltLowerBoundMs: difference(
      clock?.contextBuiltExchangeLowerBoundMs,
      btc?.observedAtMs,
    ),
    eventAgeAtDecisionLowerBoundMs:
      clock && typeof ctx.exchangeObservedAtMs === 'number' && btc
        ? ctx.exchangeObservedAtMs - clock.requestRoundTripMs - btc.observedAtMs
        : null,
    providerReceiveAgeAtDecisionMs: difference(ctx.observedAtMs, btc?.receivedAtMs),
    providerReceiveAgeAtBuilderEndMs: difference(timing?.contextBuiltAtMs, btc?.receivedAtMs),
    recordedDataQuality: ctx.dataQuality,
  };
}

/** Descriptive predicates from saved inputs, not a second evaluator or an entry verdict. */
export function unreachedGuardFacts(replay: MicroBurstExactReplay, side: Side): JsonObject {
  const { context: ctx, config } = replay;
  const sign = side === 'LONG' ? 1 : -1;
  const quote =
    side === 'LONG' ? ctx.executionBook?.askDepth[0]?.price : ctx.executionBook?.bidDepth[0]?.price;
  const targetType = side === 'LONG' ? 'resistance' : 'support';
  const targets = [...ctx.levels.levels, ctx.levels.nearest.support, ctx.levels.nearest.resistance]
    .filter((level): level is NonNullable<typeof level> => !!level)
    .filter(
      (level) =>
        level.type === targetType &&
        Number.isFinite(quote) &&
        level.availableAtMs <= ctx.timestamp &&
        sign * (level.price - quote!) > 0,
    )
    .sort((a, b) => sign * (a.price - b.price) || a.availableAtMs - b.availableAtMs);
  return {
    authority: 'DIAGNOSTIC_ONLY_NO_GUARDS_BYPASSED_NO_ENTRY_VERDICT',
    unreached: [
      'BOOK_HEALTH',
      'BTC_EVENT_FRESHNESS',
      'SNAPSHOT_FRESHNESS',
      'EXECUTION_BOOK_FRESHNESS',
      'EXECUTABLE_SPREAD',
      'FLOW',
      'CANDLE_INTEGRITY',
      'CANDLE_FRESHNESS',
      'LEVEL_INPUT_BOUND',
      'LEVEL_SELECTION',
      'TRIGGER_AVAILABILITY',
      'DEFENSE_PROXIMITY',
      'DIRECTION_AND_FLOW',
      'TRIGGER',
      'DEFENSE_DEGRADATION',
      'BTC_CONFLICT',
      'STRUCTURAL_LEVELS',
      'EXECUTABLE_GEOMETRY',
      'GROSS_ROOM',
      'GROSS_REWARD_RISK',
      'LEVERAGE_TIER',
      'NET_ROOM_AND_REWARD_RISK',
    ],
    candidateSide: side,
    momentumDirection: ctx.momentum.direction,
    momentumMatchesCandidate: ctx.momentum.direction === side,
    savedNetTakerFlow: ctx.aggTradeFlow?.netTakerFlow ?? null,
    flowSignMatchesCandidate: ctx.aggTradeFlow ? sign * ctx.aggTradeFlow.netTakerFlow > 0 : null,
    quote,
    referenceTarget: ctx.levels.nearest[targetType],
    closestAvailableOpposingLevelAheadOfQuote: targets[0] ?? null,
    snapshotAgeAtEvaluationUpperBoundMs: ctx.exchangeObservedAtMs! - ctx.timestamp,
    executionBookLocalAgeMs: ctx.executionBook
      ? ctx.observedAtMs! - ctx.executionBook.observedAtMs
      : null,
    flowEventAgeAtEvaluationUpperBoundMs:
      typeof ctx.aggTradeFlow?.eventWatermarkMs === 'number'
        ? ctx.exchangeObservedAtMs! - ctx.aggTradeFlow.eventWatermarkMs
        : null,
    thresholds: {
      bookFreshnessMaxMs: config.bookFreshnessMaxMs,
      nearLevelThresholdBps: config.nearLevelThresholdBps,
      minRoomBps: config.minRoomBps,
      minRewardRisk: config.minRewardRisk,
      exitEstimatedRoundTripCostBps: config.exitEstimatedRoundTripCostBps,
    },
  };
}

/** Inspect saved facts only: no replacement data, reclassification or guard bypass. */
export async function investigateMicroBurstInputs(
  inputFile: string,
  snapshotDirectory?: string,
): Promise<JsonObject> {
  const revisions: Record<string, JsonObject[]> = { XRPUSDT: [], SUIUSDT: [] };
  const targetOpenTime = 1789329180000;
  const confirmations: JsonObject[] = [];
  const btcTransitions: JsonObject[] = [];
  let lastBtcFingerprint: string | undefined;
  const snapshotReferences = new Set<string>();
  const referenceHashes = new Map<string, string>();
  const validationErrors: JsonObject[] = [];
  const commits = new Set<string>();
  let validated = 0;
  const source = await scanStableJsonl(inputFile, (value, line) => {
    const record = value as StrategyDecisionEvidenceV2;
    if (record?.strategy?.strategyId !== 'MICRO_BURST') return;
    let replay: MicroBurstExactReplay;
    try {
      replay = decodeValidatedPatternReplay(
        record.diagnostics.strategyInputReplay,
        record.strategy.codeCommitSha,
      ).replay;
    } catch (error) {
      validationErrors.push({ line, error: String(error) });
      return;
    }
    validated++;
    commits.add(record.strategy.codeCommitSha);
    referenceHashes.set(record.marketSnapshotId, record.marketSnapshotContentHash);
    const ctx = replay.context;
    const envelope = {
      line,
      decisionId: record.decisionId,
      symbol: record.symbol,
      strategyTimestampMs: record.strategyTimestampMs,
      evaluatedAtReceivedMs: record.evaluatedAtReceivedMs,
      recordedAtMs: record.recordedAtMs,
      marketSnapshotId: record.marketSnapshotId,
      observedMarketSnapshotId: record.observedMarketSnapshotId ?? null,
      marketSnapshotContentHash: record.marketSnapshotContentHash,
      marketSnapshotStored: record.marketSnapshotStored,
      inputCaptureTiming: ctx.inputCaptureTiming,
      clockReference: ctx.clockReference,
    };
    const raw = ctx.inputSources?.rawCandles.candles1m.find((c) => c.openTime === targetOpenTime);
    const prepared = ctx.candles.candles1m.find((c) => c.openTime === targetOpenTime);
    if (revisions[ctx.symbol] && raw) {
      const classification = prepared ? 'IN_PREPARED_CLOSED_SERIES' : 'RAW_ONLY';
      const signature = evidenceHash({ raw, prepared, classification });
      const group = revisions[ctx.symbol];
      const previous = group[group.length - 1];
      if (previous?.signature === signature) {
        previous.lastLine = line;
        previous.observations = Number(previous.observations) + 1;
      } else {
        snapshotReferences.add(record.marketSnapshotId);
        group.push({
          signature,
          interval: '1m',
          openTime: targetOpenTime,
          classification,
          firstLine: line,
          lastLine: line,
          observations: 1,
          envelope,
          raw: candleFingerprint(raw),
          prepared: prepared ? candleFingerprint(prepared) : null,
          rawNumericallyEqualsPrepared: prepared
            ? candleFingerprint(raw).numericalSha256 === candleFingerprint(prepared).numericalSha256
            : null,
          snapshotMinusCloseMs: ctx.timestamp - raw.closeTime,
          builderTiming: ctx.inputSources?.timing,
          sourceOrigin:
            'ADAPTER_GET_CANDLES_RESULT; ORIGINAL_REST_PAYLOAD_CACHE_FETCH_TIME_AND_CLOSED_FLAG_NOT_SAVED',
        });
      }
    }
    // conflictFlag is candidate-specific; it is not a provider update.
    const fingerprint = evidenceHash(
      ctx.btcContext ? { ...ctx.btcContext, conflictFlag: undefined } : null,
    );
    if (fingerprint !== lastBtcFingerprint) {
      btcTransitions.push({ ...envelope, ...btcTimeline(replay) });
      lastBtcFingerprint = fingerprint;
    }
    const candidateSide =
      record.decisionId === '8364087ceb1fcc3fd0749078971c1d86f505f20331abb6ca41928f74d1ea02a6'
        ? 'LONG'
        : record.decisionId === '511a8a7f2f6eb2a3836fb256a863baee1773737f4d6aad4074b8a768d4ca8be4'
          ? 'SHORT'
          : null;
    if (candidateSide) {
      snapshotReferences.add(record.marketSnapshotId);
      confirmations.push({
        ...envelope,
        ...btcTimeline(replay),
        recordedReason: record.reason,
        reachedStages: record.diagnostics.commonStagesVisited,
        recordedSides: record.diagnostics.sides,
        unexecutedGuardStatus: 'NOT_REACHED_NOT_PASSED; NO_BYPASS_EVALUATION',
        unreachedGuardFacts: unreachedGuardFacts(replay, candidateSide),
        savedInputsForUnreachedChecks: {
          momentum: ctx.momentum,
          aggTradeFlow: ctx.aggTradeFlow,
          bookPressure: ctx.bookPressure,
          nearestLevels: ctx.levels.nearest,
          executableBook: ctx.executionBook
            ? {
                observedAtMs: ctx.executionBook.observedAtMs,
                status: ctx.executionBook.status,
                bid: ctx.executionBook.bidDepth[0],
                ask: ctx.executionBook.askDepth[0],
              }
            : null,
        },
      });
    }
  });
  const snapshots: JsonObject[] = [];
  const snapshotSources: JsonObject[] = [];
  if (snapshotDirectory)
    for (const name of readdirSync(snapshotDirectory)
      .filter((name) => /^snapshots-v2.*\.jsonl(?:\.gz)?$/.test(name))
      .sort()) {
      snapshotSources.push(
        await scanStableJsonl(resolve(snapshotDirectory, name), (value, line) => {
          const record = value as { snapshotId: string; contentHash: string; marketSnapshot: any };
          if (!snapshotReferences.has(record.snapshotId)) return;
          const s = record.marketSnapshot;
          const recomputed = hash(
            JSON.stringify({
              schemaVersion: s.schemaVersion,
              symbol: s.symbol,
              primary: s.primary,
              benchmark: s.benchmark,
              health: s.health,
              provenance: s.provenance,
            }),
          );
          snapshots.push({
            source: name,
            line,
            ...record,
            recomputedContentHash: recomputed,
            contentHashAgrees: recomputed === record.contentHash,
            decisionReferenceHashAgrees:
              referenceHashes.get(record.snapshotId) === record.contentHash,
          });
        }),
      );
    }
  const paths = [
    'src/infra/adapters/BinanceAdapter.ts',
    'src/core/market-data/CandleIntegrity.ts',
    'src/core/market-data/MarketDataCandleProvider.ts',
    'src/strategies/micro-burst/domain/BtcMicroContextProvider.ts',
    'src/strategies/micro-burst/domain/MicroBurstContextBuilder.ts',
    'src/strategies/micro-burst/application/MicroBurstEvaluator.ts',
    'src/strategies/micro-burst/application/MicroBurstRuntime.ts',
    'src/strategies/micro-burst/application/MicroBurstBlackBoxObservation.ts',
  ];
  return {
    mode: 'OFFLINE_INPUT_FORENSICS_NO_GUARD_BYPASS',
    source,
    validated,
    validationErrors,
    historicalCodeEvidence: [...commits].map((commit) => ({
      commit,
      diff: execFileSync('git', ['diff', commit, '--', ...paths], {
        cwd: RESEARCH_ROOT,
        encoding: 'utf8',
      }),
      sourceHashes: Object.fromEntries(
        paths.map((path) => [
          path,
          {
            historical: hash(
              execFileSync('git', ['show', `${commit}:${path}`], { cwd: RESEARCH_ROOT }),
            ),
            worktree: hash(readFileSync(resolve(RESEARCH_ROOT, path))),
          },
        ]),
      ),
    })),
    revisions,
    confirmations,
    btcTransitions,
    btcTransitionSummary: btcTransitions.map((transition) => ({
      line: transition.line,
      symbol: transition.symbol,
      decisionAtLocalMs: transition.decisionAtLocalMs,
      btc: transition.btc,
    })),
    snapshotCoverage: {
      requestedIds: snapshotReferences.size,
      matchedRecords: snapshots.length,
      contentHashMismatches: snapshots.filter((s) => !s.contentHashAgrees).length,
      decisionReferenceHashMismatches: snapshots.filter((s) => !s.decisionReferenceHashAgrees)
        .length,
    },
    snapshotSources,
    snapshots,
    unmatchedSnapshotIds: [...snapshotReferences].filter(
      (id) => !snapshots.some((s) => s.snapshotId === id),
    ),
  };
}

if (require.main === module) {
  if (process.argv.length < 3 || process.argv.length > 4)
    throw new Error('USAGE: MicroBurstInputForensics.ts ROTATED_DECISIONS [SNAPSHOT_DIRECTORY]');
  investigateMicroBurstInputs(process.argv[2], process.argv[3]).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
