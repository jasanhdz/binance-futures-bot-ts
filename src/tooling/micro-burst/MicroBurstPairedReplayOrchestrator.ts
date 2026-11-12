import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MICRO_EVALUATOR_REVISION } from '../../strategies/micro-burst/domain/MicroBurstExactReplay';
import {
  openVerifiedCaptureSession,
  readVerifiedDecisionRecords,
  readVerifiedFundingEvidence,
} from './MicroBurstCaptureSession';
import { MicroBurstPullbackCandidate } from './MicroBurstPullbackCandidate';
import { replayPairedExecutions, type EpisodeExecution } from './MicroBurstPairedExecutionReplay';
import { summarizePairedReplay } from './MicroBurstPairedReplayReport';
import {
  buildVerifiedReplayFrame,
  type VerifiedReplayFrame,
} from './MicroBurstVerifiedReplayFrame';
import {
  MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256,
  MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1,
} from './MicroBurstReplayEvidenceContract';

const REQUEST_SCHEMA = 'MICRO_PAIRED_ARCHIVE_REPLAY_REQUEST_V1';
const MAX_RANGE_MS = 10 * 60_000;
const MAX_DECISIONS = 20_000;
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface PairedReplayRequest {
  schema: typeof REQUEST_SCHEMA;
  captureRoot: string;
  outputDir: string;
  symbol: string;
  range: { fromReceivedAtMs: number; throughReceivedAtMs: number };
  selection: { episodeId?: string; selectionHorizonMs: number | null };
  experiment: {
    schema: 'MICRO_PAIRED_REPLAY_EVIDENCE_V1';
    sha256: string;
  };
  execution: {
    riskBudgetUsdt: number;
    maxNotionalUsdt: number;
    quantityStep: number;
    minNotionalUsdt: number;
    feeBpsPerSide: number;
    adverseSlippageBps: number;
    entryDelayMs: number;
    exitDelayMs: number;
  };
}

interface DecisionTrace {
  decisionId: string;
  episodeId: string | null;
  symbol: string;
  strategyCodeCommitSha: string;
  strategyConfigSha256: string;
  evaluatedAtReceivedMs: number;
  exchangeAsOfMs: number | null;
  storedCurrentAction: string;
  currentVerification: 'RE_EVALUATION_AGREED' | 'TECHNICAL_ERROR';
  pullbackDisposition?: string;
  pullbackReason?: string;
  frameStatus?: string;
  frameReason?: string;
  exitPolicyConfigSha256?: string;
}

/** End-to-end local archive replay. Input archive is opened read-only by its verifier. */
export async function runPairedReplayRequestFile(requestPath: string): Promise<{
  status: string;
  outputDir: string;
  reportSha256: string;
  summarySha256: string;
}> {
  const requestFile = resolve(requestPath);
  const requestSize = statSync(requestFile).size;
  if (requestSize <= 0 || requestSize > MAX_REQUEST_BYTES)
    throw new Error('PAIRED_REPLAY_REQUEST_SIZE_INVALID');
  const requestStat = readFileSync(requestFile);
  if (requestStat.length !== requestSize) throw new Error('PAIRED_REPLAY_REQUEST_SIZE_INVALID');
  let request: PairedReplayRequest;
  try {
    request = JSON.parse(requestStat.toString('utf8')) as PairedReplayRequest;
  } catch {
    throw new Error('PAIRED_REPLAY_REQUEST_JSON_INVALID');
  }
  validateRequest(request);

  const session = await openVerifiedCaptureSession(request.captureRoot);
  const { fromReceivedAtMs, throughReceivedAtMs } = request.range;
  if (fromReceivedAtMs < session.startedAtMs || throughReceivedAtMs > session.completedAtMs)
    throw new Error('PAIRED_REPLAY_RANGE_OUTSIDE_VERIFIED_SESSION');
  const allRecords = await readVerifiedDecisionRecords(
    session,
    fromReceivedAtMs,
    throughReceivedAtMs,
    MAX_DECISIONS,
  );
  if (allRecords.length > MAX_DECISIONS) throw new Error('PAIRED_REPLAY_DECISION_CAP_EXCEEDED');
  const records = allRecords.filter((record) => record.symbol === request.symbol);
  const candidate = new MicroBurstPullbackCandidate();
  const frames: VerifiedReplayFrame[] = [];
  const trace: DecisionTrace[] = [];
  const technicalErrors: Array<{ decisionId: string; episodeId: string | null; reason: string }> =
    [];
  const blockedEpisodeIds = new Set<string>();
  let previous: VerifiedReplayFrame | undefined;

  for (const record of records) {
    const episodeId =
      typeof record.diagnostics.episodeId === 'string' ? record.diagnostics.episodeId : null;
    try {
      const observation = await candidate.evaluate(session, record);
      const frame = await buildVerifiedReplayFrame(session, record, observation, previous);
      frames.push(frame);
      previous = frame;
      trace.push({
        decisionId: record.decisionId,
        episodeId,
        symbol: record.symbol,
        strategyCodeCommitSha: record.strategy.codeCommitSha,
        strategyConfigSha256: record.strategy.configHash!,
        evaluatedAtReceivedMs: record.evaluatedAtReceivedMs,
        exchangeAsOfMs: frame.exchangeAsOfMs,
        storedCurrentAction: record.decision,
        currentVerification: 'RE_EVALUATION_AGREED',
        pullbackDisposition: observation.disposition,
        pullbackReason: observation.reason,
        frameStatus: frame.verificationStatus,
        frameReason: frame.reason,
        exitPolicyConfigSha256: frame.exitPolicyConfigSha256,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'UNKNOWN_TECHNICAL_ERROR';
      technicalErrors.push({ decisionId: record.decisionId, episodeId, reason });
      if (episodeId) blockedEpisodeIds.add(episodeId);
      trace.push({
        decisionId: record.decisionId,
        episodeId,
        symbol: record.symbol,
        strategyCodeCommitSha: record.strategy.codeCommitSha,
        strategyConfigSha256: record.strategy.configHash!,
        evaluatedAtReceivedMs: record.evaluatedAtReceivedMs,
        exchangeAsOfMs: null,
        storedCurrentAction: record.decision,
        currentVerification: 'TECHNICAL_ERROR',
      });
      candidate.reset();
      previous = undefined;
    }
  }

  const replayFrames = frames.filter(
    (frame) => !blockedEpisodeIds.has(String(frame.observation.baseline.diagnostics.episodeId)),
  );
  const exchangeTimes = replayFrames.map((frame) => frame.exchangeAsOfMs);
  const fundingEvidence = replayFrames.length
    ? await readVerifiedFundingEvidence(
        session,
        request.symbol,
        Math.min(...exchangeTimes),
        Math.max(...exchangeTimes),
      )
    : null;
  const executions: readonly EpisodeExecution[] = replayPairedExecutions(replayFrames, {
    ...request.execution,
    fundingEvidence,
  });
  const episodeFilter = request.selection.episodeId
    ? new Set([request.selection.episodeId])
    : undefined;
  const paired = summarizePairedReplay(replayFrames, executions, episodeFilter);
  const executionByKey = new Map(
    executions.map((execution) => [`${execution.variant}:${execution.episodeId}`, execution]),
  );
  const technicalEpisodeIds = new Set(
    technicalErrors.flatMap((error) => (error.episodeId ? [error.episodeId] : [])),
  );
  const terminalOutcomes = paired.terminalOutcomes.map((row) => {
    const signalAt = replayFrames.find(
      (frame) => frame.observation.baseline.diagnostics.episodeId === row.episodeId,
    )?.decisionAvailableAtMs;
    const horizonExpired =
      request.selection.selectionHorizonMs !== null &&
      signalAt !== undefined &&
      request.range.throughReceivedAtMs >= signalAt + request.selection.selectionHorizonMs &&
      row.pullbackSelection === 'WAITING';
    return {
      ...row,
      current:
        !executionByKey.has(`CURRENT:${row.episodeId}`) && technicalEpisodeIds.has(row.episodeId)
          ? 'TECHNICAL_ERROR'
          : row.current,
      currentReason:
        !executionByKey.has(`CURRENT:${row.episodeId}`) && technicalEpisodeIds.has(row.episodeId)
          ? (technicalErrors.find((error) => error.episodeId === row.episodeId)?.reason ??
            row.currentReason)
          : row.currentReason,
      pullback:
        !executionByKey.has(`PULLBACK:${row.episodeId}`) && technicalEpisodeIds.has(row.episodeId)
          ? 'TECHNICAL_ERROR'
          : horizonExpired
            ? 'SELECTION_WINDOW_EXPIRED_WITHOUT_QUALIFICATION'
            : row.pullback,
      pullbackReason:
        !executionByKey.has(`PULLBACK:${row.episodeId}`) && technicalEpisodeIds.has(row.episodeId)
          ? (technicalErrors.find((error) => error.episodeId === row.episodeId)?.reason ??
            row.pullbackReason)
          : horizonExpired
            ? 'EXPLICIT_RESEARCH_SELECTION_HORIZON_EXPIRED'
            : row.pullbackReason,
    };
  });
  const knownTerminalIds = new Set(terminalOutcomes.map((row) => row.episodeId));
  const technicalOnlyEpisodeIds = new Set(
    trace
      .filter(
        (row) =>
          row.episodeId !== null &&
          row.storedCurrentAction === 'ENTRY_INTENT' &&
          row.currentVerification === 'TECHNICAL_ERROR' &&
          (!episodeFilter || episodeFilter.has(row.episodeId)),
      )
      .map((row) => row.episodeId as string),
  );
  for (const episodeId of technicalOnlyEpisodeIds) {
    if (knownTerminalIds.has(episodeId)) continue;
    terminalOutcomes.push({
      episodeId,
      current: 'TECHNICAL_ERROR',
      currentReason:
        technicalErrors.find((error) => error.episodeId === episodeId)?.reason ??
        'CURRENT_DECISION_TECHNICAL_ERROR',
      pullback: 'TECHNICAL_ERROR',
      pullbackReason:
        technicalErrors.find((error) => error.episodeId === episodeId)?.reason ??
        'CURRENT_DECISION_TECHNICAL_ERROR',
      pullbackSelection: 'TECHNICAL_ERROR',
      executionKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL',
    });
  }
  const uniqueEpisodeIds = terminalOutcomes.map((row) => row.episodeId);
  const policyConfigs = new Map(
    replayFrames.map((frame) => [frame.exitPolicyConfigSha256, frame.exitPolicyConfig]),
  );
  const decisionsForReport = request.selection.episodeId
    ? trace.filter((row) => row.episodeId === request.selection.episodeId)
    : trace;
  const selectedExecutions = request.selection.episodeId
    ? executions.filter((row) => row.episodeId === request.selection.episodeId)
    : executions;
  const selectedFrames = request.selection.episodeId
    ? replayFrames.filter(
        (frame) => frame.observation.baseline.diagnostics.episodeId === request.selection.episodeId,
      )
    : replayFrames;
  const selectedTechnicalErrors = request.selection.episodeId
    ? technicalErrors.filter((row) => row.episodeId === request.selection.episodeId)
    : technicalErrors;
  const report = {
    schema: 'MICRO_PAIRED_ARCHIVE_REPLAY_REPORT_V1',
    status:
      uniqueEpisodeIds.length === 0
        ? selectedTechnicalErrors.length
          ? 'COMPLETED_WITH_TECHNICAL_ERRORS_NO_ELIGIBLE_EPISODES'
          : 'NO_ELIGIBLE_EPISODES'
        : selectedTechnicalErrors.length
          ? 'COMPLETED_WITH_TECHNICAL_ERRORS'
          : 'COMPLETED',
    authority: 'OFFLINE_DESCRIPTIVE_RESEARCH_ONLY',
    executionKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL',
    source: {
      sessionManifestSha256: session.manifestSha256,
      producerArtifactSha256: session.artifactHash,
      producerCommit: session.producerCommit,
      sessionConfigSha256: session.configHash,
    },
    executor: {
      checkoutCommit: git(['rev-parse', 'HEAD']),
      sourceWorktreeDirty:
        git(['status', '--porcelain', '--untracked-files=normal', '--', 'src']).length > 0,
      sourceTreeSha256: executorSourceSha256(),
      evaluatorRevision: MICRO_EVALUATOR_REVISION,
      nodeVersion: process.version,
      currentDecisionMode: 'RE_EVALUATION_USING_CAPTURED_INPUTS',
      historicalAgreement: 'REQUIRED_FOR_EVERY_VERIFIED_FRAME',
    },
    experiment: {
      schema: MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.schema,
      sha256: MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256,
      pullbackExperimentSha256: MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.pullbackExperimentSha256,
      selectionHorizonMs: request.selection.selectionHorizonMs,
    },
    policies: {
      currentEvaluatorRevision: MICRO_EVALUATOR_REVISION,
      pullbackSelectorSha256: MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.pullbackExperimentSha256,
      exitPolicyConfigurations: [...policyConfigs].map(([sha256, config]) => ({ sha256, config })),
      episodeIdentity:
        'BASELINE diagnostics.episodeId; one CURRENT and at most one PULLBACK result per episode id; repeated decisions are observations, not independent trades',
    },
    request: {
      requestSha256: sha256(
        canonical({
          symbol: request.symbol,
          range: request.range,
          selection: request.selection,
          experiment: request.experiment,
          execution: request.execution,
        }),
      ),
      symbol: request.symbol,
      rangeClock: 'LOCAL_RECEIVE_TIME',
      range: request.range,
      selection: request.selection,
      selectionCriterion: request.selection.episodeId
        ? 'EXACT_EPISODE_ID'
        : 'ALL_EPISODES_IN_RANGE',
      maxRangeMs: MAX_RANGE_MS,
      decisionCap: MAX_DECISIONS,
    },
    executionAssumptions: {
      ...request.execution,
      fundingEvidenceSha256: fundingEvidence?.evidenceSha256 ?? null,
      riskSizing: 'COMMON_RESEARCH_USDT_RISK_BUDGET_NOT_LIVE_MARGIN_SIZING',
      exitPath: 'CAPTURED_DECISION_FRAMES_WITH_VERIFIED_DEPTH_INTERVALS',
      exitFidelity: 'NOT_CERTIFIED_BETWEEN_DECISIONS_OR_AS_EXCHANGE_PROTECTION',
      stopAssumption: 'IMMEDIATE_STOP_COVERAGE_NOT_EXCHANGE_VALIDATED',
    },
    counts: {
      decisionsRead: allRecords.length,
      decisionsForSymbol: records.length,
      decisionsReported: decisionsForReport.length,
      uniqueEpisodes: uniqueEpisodeIds.length,
      verifiedFrames: selectedFrames.length,
      unknownFrames: selectedFrames.filter((frame) => frame.verificationStatus === 'UNKNOWN')
        .length,
      pullbackWaiting: decisionsForReport.filter((row) => row.pullbackDisposition === 'WAITING')
        .length,
      pullbackRejected: decisionsForReport.filter(
        (row) => row.pullbackDisposition === 'STRATEGY_REJECTED',
      ).length,
      pullbackEvidenceRejected: decisionsForReport.filter(
        (row) => row.pullbackDisposition === 'DATA_UNAVAILABLE',
      ).length,
      technicalErrors: selectedTechnicalErrors.length,
      executions: selectedExecutions.length,
      fundingUnavailable: fundingEvidence === null,
    },
    observations: decisionsForReport,
    evidenceRejections: selectedFrames.flatMap((frame) =>
      frame.verificationStatus === 'UNKNOWN'
        ? [{ decisionId: frame.decisionId, reason: frame.reason ?? 'UNKNOWN_EVIDENCE' }]
        : [],
    ),
    technicalErrors: selectedTechnicalErrors,
    executions: selectedExecutions,
    terminalOutcomes,
    selectionComparison: paired.selection,
    economicComparison: {
      current: paired.operable.current,
      pullback: paired.operable.pullback,
      pairedClosedEpisodes: paired.operable.pairedClosedEpisodes,
      meanPairedDeltaUsdt: paired.operable.meanPairedDeltaUsdt,
      metric: 'CLOSED_MODELLED_EPISODES_ONLY',
      excludedFromPairedDelta: terminalOutcomes
        .filter((row) => row.current !== 'MODELLED_CLOSED' || row.pullback !== 'MODELLED_CLOSED')
        .map((row) => ({ episodeId: row.episodeId, current: row.current, pullback: row.pullback })),
      currentMean: {
        denominator: paired.operable.current.closed,
        excludedEpisodeIds: terminalOutcomes
          .filter((row) => row.current !== 'MODELLED_CLOSED')
          .map((row) => row.episodeId),
      },
      pullbackMean: {
        denominator: paired.operable.pullback.closed,
        excludedEpisodeIds: terminalOutcomes
          .filter((row) => row.pullback !== 'MODELLED_CLOSED')
          .map((row) => row.episodeId),
      },
      terminalCounts: {
        current: countBy(terminalOutcomes.map((row) => row.current)),
        pullback: countBy(terminalOutcomes.map((row) => row.pullback)),
      },
      emptyMeanIsNullNotZero: true,
    },
    limitations: [
      'Historical CURRENT inputs are re-evaluated by this executor and must agree with the stored decision; this is not a claim that the historical binary was rerun.',
      'Verified depth continuity proves archived updates and decision endpoints, not complete exchange-feed delivery or every intrainterval exit-policy context.',
      'Modeled VWAP is not an exchange fill; latency, queue position, impact, margin, liquidation, and actual protection behavior are not reproduced.',
      'The common research risk budget is not LIVE margin-fraction sizing.',
      'Incomplete and UNKNOWN episodes have no terminal PnL; they remain in terminal counts and are excluded explicitly from closed-pair metrics.',
    ],
    pairedReport: {
      ...paired,
      independentBaselineEpisodes: uniqueEpisodeIds.length,
      terminalOutcomes,
    },
  };
  const status = report.status;
  const outputDir = resolve(request.outputDir);
  assertOutputOutsideCapture(session.root, outputDir);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  assertOutputOutsideCapture(session.root, outputDir);
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  const summaryBytes = `${renderSummary(report)}\n`;
  writeFileSync(resolve(outputDir, 'report.json'), reportBytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(resolve(outputDir, 'summary.md'), summaryBytes, { flag: 'wx', mode: 0o600 });
  return {
    status,
    outputDir,
    reportSha256: sha256(reportBytes),
    summarySha256: sha256(summaryBytes),
  };
}

function validateRequest(request: PairedReplayRequest): void {
  if (!request || request.schema !== REQUEST_SCHEMA)
    throw new Error('INCOMPATIBLE_PAIRED_REPLAY_REQUEST_SCHEMA');
  if (
    typeof request.captureRoot !== 'string' ||
    !request.captureRoot ||
    typeof request.outputDir !== 'string' ||
    !request.outputDir ||
    !/^[A-Z0-9]{2,20}USDT$/.test(request.symbol)
  )
    throw new Error('PAIRED_REPLAY_PATH_OR_SYMBOL_INVALID');
  const { fromReceivedAtMs, throughReceivedAtMs } = request.range ?? {};
  if (
    ![fromReceivedAtMs, throughReceivedAtMs].every(Number.isFinite) ||
    throughReceivedAtMs! <= fromReceivedAtMs! ||
    throughReceivedAtMs! - fromReceivedAtMs! > MAX_RANGE_MS
  )
    throw new Error('PAIRED_REPLAY_RANGE_INVALID_OR_UNBOUNDED');
  if (
    !request.selection ||
    (request.selection.episodeId !== undefined &&
      (typeof request.selection.episodeId !== 'string' || !request.selection.episodeId)) ||
    (request.selection.selectionHorizonMs !== null &&
      (!Number.isFinite(request.selection.selectionHorizonMs) ||
        request.selection.selectionHorizonMs <= 0 ||
        request.selection.selectionHorizonMs > MAX_RANGE_MS))
  )
    throw new Error('PAIRED_REPLAY_SELECTION_CRITERIA_INVALID');
  if (
    request.experiment?.schema !== MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.schema ||
    request.experiment.sha256 !== MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256
  )
    throw new Error('PAIRED_REPLAY_EXPERIMENT_CONTRACT_MISMATCH');
  if (
    !request.execution ||
    Object.keys(request.execution).sort().join(',') !==
      [
        'adverseSlippageBps',
        'entryDelayMs',
        'exitDelayMs',
        'feeBpsPerSide',
        'maxNotionalUsdt',
        'minNotionalUsdt',
        'quantityStep',
        'riskBudgetUsdt',
      ]
        .sort()
        .join(',') ||
    !Object.values(request.execution).every(Number.isFinite)
  )
    throw new Error('PAIRED_REPLAY_EXECUTION_ASSUMPTIONS_INVALID');
}

function assertOutputOutsideCapture(captureRoot: string, outputDir: string): void {
  const root = realpathSync(resolve(captureRoot));
  let probe = resolve(outputDir);
  const suffix: string[] = [];
  while (!existsSync(probe)) {
    suffix.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const actualOutput = resolve(realpathSync(probe), ...suffix);
  const relativePath = relative(root, actualOutput);
  if (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
    throw new Error('PAIRED_REPLAY_OUTPUT_MUST_BE_SEPARATE_FROM_CAPTURE');
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: resolve(__dirname, '../../..'),
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: process.env.PATH ?? '' },
  }).trim();
}

function executorSourceSha256(): string {
  const cwd = resolve(__dirname, '../../..');
  const scope = [
    'package.json',
    'src/tooling/micro-burst',
    'src/strategies/micro-burst',
    'src/core/blackbox',
    'src/core/types.ts',
  ];
  const diff = git(['diff', 'HEAD', '--no-ext-diff', '--binary', '--', ...scope]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...scope])
    .split('\n')
    .filter(Boolean)
    .sort()
    .map((path) => `${path}:${sha256(readFileSync(resolve(cwd, path)).toString('base64'))}`);
  return sha256(`${diff}\n${untracked.join('\n')}`);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function renderSummary(report: Record<string, any>): string {
  const economic = report.economicComparison;
  const lines = [
    '# Micro paired archive replay',
    '',
    `- Status: **${report.status}**`,
    `- Authority: ${report.authority}`,
    `- Execution kind: ${report.executionKind}`,
    `- Session manifest: \`${report.source.sessionManifestSha256}\``,
    `- Contract: \`${report.experiment.sha256}\``,
    `- Selection: ${report.request.symbol}, ${report.request.range.fromReceivedAtMs}–${report.request.range.throughReceivedAtMs} local receive ms${report.request.selection.episodeId ? `, episode \`${report.request.selection.episodeId}\`` : ''}`,
    `- Decisions: ${report.counts.decisionsRead}; symbol decisions: ${report.counts.decisionsForSymbol}; unique episodes: ${report.counts.uniqueEpisodes}`,
    `- Frames: ${report.counts.verifiedFrames}; unknown frames: ${report.counts.unknownFrames}; technical errors: ${report.counts.technicalErrors}`,
    '',
    '## Terminal outcomes',
    '',
  ];
  if (report.terminalOutcomes.length === 0) lines.push('No eligible episodes were observed.');
  else {
    lines.push('| Episode | CURRENT | Motivo CURRENT | PULLBACK | Motivo PULLBACK | Selección |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of report.terminalOutcomes)
      lines.push(
        `| ${row.episodeId} | ${row.current} | ${row.currentReason ?? '—'} | ${row.pullback} | ${row.pullbackReason ?? '—'} | ${row.pullbackSelection} |`,
      );
  }
  lines.push(
    '',
    '## Modelled economics',
    '',
    `- CURRENT closed denominator: ${economic.current.closed}; mean net USDT: ${economic.current.meanNetUsdt ?? 'n/a'}`,
    `- PULLBACK closed denominator: ${economic.pullback.closed}; mean net USDT: ${economic.pullback.meanNetUsdt ?? 'n/a'}`,
    `- Paired closed episodes: ${economic.pairedClosedEpisodes}; mean paired delta USDT: ${economic.meanPairedDeltaUsdt ?? 'n/a'}`,
    `- Excluded from paired delta: ${economic.excludedFromPairedDelta.length}`,
    '',
    '## Limitations',
    '',
    ...report.limitations.map((item: string) => `- ${item}`),
    '',
  );
  return lines.join('\n');
}
