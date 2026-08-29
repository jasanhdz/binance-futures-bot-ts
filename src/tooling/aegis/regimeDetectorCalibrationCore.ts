import { promises as fs } from 'fs';
import path from 'path';
import {
  auditRegimeDetectorDeep,
  DeepRegimeAuditOptions,
  DeepRegimeAuditReport,
  DeepRegimeMetricRow,
  DEFAULT_DEEP_REGIME_SYMBOLS,
  DEFAULT_TECHNICAL_REGIME_THRESHOLDS,
  TechnicalRegimeLabel,
  TechnicalRegimeThresholds,
} from './regimeDetectorDeepAuditCore';
import { Side } from '../../core/types';

export type BucketClassification =
  | 'strong_allow'
  | 'allow'
  | 'neutral'
  | 'avoid'
  | 'strong_avoid'
  | 'insufficient_data';

export type CalibrationThresholds = {
  strongMinCount: number;
  strongMinMfeMae: number;
  strongMinHit8: number;
  strongMaxP90Mae: number;
  allowMinCount: number;
  allowMinMfeMae: number;
  allowMinHit8: number;
  avoidMaxMfeMae: number;
  avoidMaxHit8: number;
  insufficientCount: number;
};

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  strongMinCount: 50,
  strongMinMfeMae: 1.2,
  strongMinHit8: 0.35,
  strongMaxP90Mae: 0.18,
  allowMinCount: 40,
  allowMinMfeMae: 1.1,
  allowMinHit8: 0.3,
  avoidMaxMfeMae: 0.95,
  avoidMaxHit8: 0.24,
  insufficientCount: 30,
};

export type RegimeBucketCalibration = {
  symbol: string;
  regime: TechnicalRegimeLabel;
  side: Side;
  horizon: string;
  count: number;
  avgForwardReturnRoe?: number;
  medianForwardReturnRoe?: number;
  avgMfeRoe?: number;
  avgMaeRoe?: number;
  mfeMaeRatio?: number;
  hit5BeforeMinus5Rate?: number;
  hit8BeforeMinus5Rate?: number;
  hit10BeforeMinus8Rate?: number;
  falseBreakoutRate?: number;
  avgTimeTo5Minutes?: number;
  avgTimeTo8Minutes?: number;
  avgTimeTo10Minutes?: number;
  worstMaeP75?: number;
  worstMaeP90?: number;
  worstMaeP95?: number;
  stabilityScore: number;
  sampleQualityScore: number;
  classification: BucketClassification;
};

export type WalkForwardFold = {
  fold: number;
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  selectedBuckets: number;
  trainEdge?: number;
  testEdge?: number;
  edgeDecay?: number;
  stableBuckets: string[];
  misleadingBuckets: string[];
  thresholds: TechnicalRegimeThresholds;
};

export type MomentumRegimeRecommendation = {
  symbol: string;
  side: Side;
  allowedRegimes: TechnicalRegimeLabel[];
  avoidRegimes: TechnicalRegimeLabel[];
  confidence: 'low' | 'medium' | 'high';
  reason: string;
};

export type RegimeCalibrationReport = {
  generatedAt: string;
  options: Required<
    Pick<
      RegimeCalibrationOptions,
      | 'from'
      | 'to'
      | 'trainDays'
      | 'testDays'
      | 'stepDays'
      | 'sampleEvery'
      | 'leverage'
      | 'limitGrid'
    >
  > &
    RegimeCalibrationOptions;
  baseline?: {
    previousGlobalFindings?: string[];
    currentGlobalFindings: string[];
  };
  buckets: RegimeBucketCalibration[];
  walkForward: WalkForwardFold[];
  thresholdCandidates: Array<{
    rank: number;
    score: number;
    thresholds: TechnicalRegimeThresholds;
    folds: number;
    avgTrainEdge?: number;
    avgTestEdge?: number;
    avgEdgeDecay?: number;
  }>;
  recommendations: MomentumRegimeRecommendation[];
  warnings: string[];
  outputFiles?: {
    json: string;
    markdown: string;
    bucketsCsv: string;
    walkForwardCsv: string;
    recommendationsMarkdown: string;
  };
};

export type RegimeCalibrationOptions = {
  candlesDbPath?: string;
  reportsDir?: string;
  symbols?: string[];
  timeframe?: string;
  from?: string;
  to?: string;
  trainDays?: number;
  testDays?: number;
  stepDays?: number;
  sampleEvery?: number;
  leverage?: number;
  limitGrid?: number;
  writeReports?: boolean;
  thresholds?: Partial<CalibrationThresholds>;
};

export async function calibrateRegimeDetector(
  options: RegimeCalibrationOptions = {},
): Promise<RegimeCalibrationReport> {
  const generatedAt = new Date().toISOString();
  const symbols = options.symbols?.length
    ? options.symbols.map((symbol) => symbol.toUpperCase())
    : DEFAULT_DEEP_REGIME_SYMBOLS;
  const from = options.from ?? '2026-05-01T00:00:00.000Z';
  const to = options.to ?? generatedAt;
  const trainDays = positive(options.trainDays, 14);
  const testDays = positive(options.testDays, 7);
  const stepDays = positive(options.stepDays, 7);
  const sampleEvery = positive(options.sampleEvery, 3);
  const leverage = positive(options.leverage, 20);
  const limitGrid = positive(options.limitGrid, 20);
  const calibrationThresholds = {
    ...DEFAULT_CALIBRATION_THRESHOLDS,
    ...(options.thresholds ?? {}),
  };
  const baseAuditOptions: DeepRegimeAuditOptions = {
    candlesDbPath:
      options.candlesDbPath ?? '/home/jasan/Develop/trading_system/data/binance_candles.db',
    reportsDir: options.reportsDir ?? '/home/jasan/Develop',
    symbols,
    timeframe: options.timeframe ?? '5m',
    sampleEvery,
    leverage,
    writeReports: false,
  };

  const baselineAudit = await auditRegimeDetectorDeep({
    ...baseAuditOptions,
    from,
    to,
    thresholds: DEFAULT_TECHNICAL_REGIME_THRESHOLDS,
  });
  const buckets = classifyBuckets(baselineAudit.bySymbolRegimeSide, calibrationThresholds);
  const thresholdCandidates = thresholdGrid().slice(0, limitGrid);
  const evaluatedCandidates = [];
  for (const candidate of thresholdCandidates) {
    const folds = await runWalkForward({
      auditOptions: baseAuditOptions,
      from,
      to,
      trainDays,
      testDays,
      stepDays,
      thresholds: candidate,
      calibrationThresholds,
    });
    evaluatedCandidates.push(scoreCandidate(candidate, folds));
  }
  const rankedCandidates = evaluatedCandidates
    .sort((a, b) => b.score - a.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const bestThresholds = rankedCandidates[0]?.thresholds ?? DEFAULT_TECHNICAL_REGIME_THRESHOLDS;
  const walkForward = await runWalkForward({
    auditOptions: baseAuditOptions,
    from,
    to,
    trainDays,
    testDays,
    stepDays,
    thresholds: bestThresholds,
    calibrationThresholds,
  });
  const recommendations = buildMomentumRecommendations(buckets, walkForward);
  const report: RegimeCalibrationReport = {
    generatedAt,
    options: {
      ...options,
      from,
      to,
      trainDays,
      testDays,
      stepDays,
      sampleEvery,
      leverage,
      limitGrid,
      symbols,
      writeReports: options.writeReports !== false,
    },
    baseline: {
      previousGlobalFindings: await loadPreviousFindings(
        options.reportsDir ?? '/home/jasan/Develop',
      ),
      currentGlobalFindings: summarizeGlobalFindings(baselineAudit),
    },
    buckets,
    walkForward,
    thresholdCandidates: rankedCandidates,
    recommendations,
    warnings: baselineAudit.warnings,
  };
  if (options.writeReports !== false) {
    report.outputFiles = await writeCalibrationReports(
      report,
      options.reportsDir ?? '/home/jasan/Develop',
    );
  }
  return report;
}

export function classifyBucket(
  row: DeepRegimeMetricRow,
  thresholds: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
): BucketClassification {
  if (row.count < thresholds.insufficientCount) return 'insufficient_data';
  const ratio = row.mfeMaeRatio ?? 0;
  const hit8 = row.hit8BeforeMinus5Rate ?? 0;
  const avgReturn = row.avgForwardReturnRoe ?? 0;
  const p90Mae = row.worstMaeP90 ?? 0;
  if (
    row.count >= thresholds.strongMinCount &&
    ratio >= thresholds.strongMinMfeMae &&
    hit8 >= thresholds.strongMinHit8 &&
    avgReturn > 0 &&
    p90Mae <= thresholds.strongMaxP90Mae
  )
    return 'strong_allow';
  if (
    row.count >= thresholds.allowMinCount &&
    ratio >= thresholds.allowMinMfeMae &&
    hit8 >= thresholds.allowMinHit8 &&
    avgReturn >= 0
  )
    return 'allow';
  if (ratio < 0.8 && avgReturn < 0 && hit8 < thresholds.avoidMaxHit8) return 'strong_avoid';
  if (ratio < thresholds.avoidMaxMfeMae || avgReturn < 0 || hit8 < thresholds.avoidMaxHit8)
    return 'avoid';
  return 'neutral';
}

export function buildWalkForwardWindows(
  from: string,
  to: string,
  trainDays: number,
  testDays: number,
  stepDays: number,
): Array<{ trainFrom: string; trainTo: string; testFrom: string; testTo: string }> {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const day = 24 * 60 * 60_000;
  const windows = [];
  for (
    let trainFromMs = fromMs;
    trainFromMs + (trainDays + testDays) * day <= toMs;
    trainFromMs += stepDays * day
  ) {
    const trainToMs = trainFromMs + trainDays * day;
    const testToMs = trainToMs + testDays * day;
    windows.push({
      trainFrom: new Date(trainFromMs).toISOString(),
      trainTo: new Date(trainToMs).toISOString(),
      testFrom: new Date(trainToMs).toISOString(),
      testTo: new Date(testToMs).toISOString(),
    });
  }
  return windows;
}

async function runWalkForward(input: {
  auditOptions: DeepRegimeAuditOptions;
  from: string;
  to: string;
  trainDays: number;
  testDays: number;
  stepDays: number;
  thresholds: TechnicalRegimeThresholds;
  calibrationThresholds: CalibrationThresholds;
}): Promise<WalkForwardFold[]> {
  const windows = buildWalkForwardWindows(
    input.from,
    input.to,
    input.trainDays,
    input.testDays,
    input.stepDays,
  );
  const folds: WalkForwardFold[] = [];
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    const train = await auditRegimeDetectorDeep({
      ...input.auditOptions,
      from: window.trainFrom,
      to: window.trainTo,
      thresholds: input.thresholds,
    });
    const test = await auditRegimeDetectorDeep({
      ...input.auditOptions,
      from: window.testFrom,
      to: window.testTo,
      thresholds: input.thresholds,
    });
    const trainBuckets = classifyBuckets(train.bySymbolRegimeSide, input.calibrationThresholds);
    const testBuckets = classifyBuckets(test.bySymbolRegimeSide, input.calibrationThresholds);
    const selected = trainBuckets.filter(
      (bucket) =>
        bucket.horizon === '60m' &&
        (bucket.classification === 'strong_allow' || bucket.classification === 'allow'),
    );
    const selectedKeys = new Set(selected.map(bucketKey));
    const testSelected = testBuckets.filter(
      (bucket) => bucket.horizon === '60m' && selectedKeys.has(bucketKey(bucket)),
    );
    const trainEdge = average(
      selected.map((bucket) => bucket.avgForwardReturnRoe).filter(isNumber),
    );
    const testEdge = average(
      testSelected.map((bucket) => bucket.avgForwardReturnRoe).filter(isNumber),
    );
    const stableBuckets = testSelected
      .filter(
        (bucket) => bucket.classification === 'strong_allow' || bucket.classification === 'allow',
      )
      .map(bucketKey)
      .slice(0, 20);
    const misleadingBuckets = selected
      .filter((bucket) => {
        const out = testSelected.find((item) => bucketKey(item) === bucketKey(bucket));
        return out && (out.classification === 'avoid' || out.classification === 'strong_avoid');
      })
      .map(bucketKey)
      .slice(0, 20);
    folds.push({
      fold: index + 1,
      ...window,
      selectedBuckets: selected.length,
      trainEdge,
      testEdge,
      edgeDecay:
        trainEdge !== undefined && testEdge !== undefined ? testEdge - trainEdge : undefined,
      stableBuckets,
      misleadingBuckets,
      thresholds: input.thresholds,
    });
  }
  return folds;
}

function classifyBuckets(
  rows: DeepRegimeMetricRow[],
  thresholds: CalibrationThresholds,
): RegimeBucketCalibration[] {
  return rows
    .filter((row) => row.symbol && row.regime && (row.side === 'LONG' || row.side === 'SHORT'))
    .map((row) => {
      const sampleQualityScore = Math.min(1, row.count / 100);
      const stabilityScore = stabilityFrom(row);
      return {
        symbol: row.symbol!,
        regime: row.regime as TechnicalRegimeLabel,
        side: row.side as Side,
        horizon: row.horizon,
        count: row.count,
        avgForwardReturnRoe: row.avgForwardReturnRoe,
        medianForwardReturnRoe: row.medianForwardReturnRoe,
        avgMfeRoe: row.avgMfeRoe,
        avgMaeRoe: row.avgMaeRoe,
        mfeMaeRatio: row.mfeMaeRatio,
        hit5BeforeMinus5Rate: row.hit5BeforeMinus5Rate,
        hit8BeforeMinus5Rate: row.hit8BeforeMinus5Rate,
        hit10BeforeMinus8Rate: row.hit10BeforeMinus8Rate,
        falseBreakoutRate: row.falseBreakoutRate,
        avgTimeTo5Minutes: row.avgTimeTo5Minutes,
        avgTimeTo8Minutes: row.avgTimeTo8Minutes,
        avgTimeTo10Minutes: row.avgTimeTo10Minutes,
        worstMaeP75: row.worstMaeP75,
        worstMaeP90: row.worstMaeP90,
        worstMaeP95: row.worstMaeP95,
        stabilityScore,
        sampleQualityScore,
        classification: classifyBucket(row, thresholds),
      };
    });
}

export function buildMomentumRecommendations(
  buckets: RegimeBucketCalibration[],
  folds: WalkForwardFold[],
): MomentumRegimeRecommendation[] {
  const stableKeys = new Set(folds.flatMap((fold) => fold.stableBuckets));
  const recommendations: MomentumRegimeRecommendation[] = [];
  const symbols = [...new Set(buckets.map((bucket) => bucket.symbol))].sort();
  for (const symbol of symbols) {
    for (const side of ['LONG', 'SHORT'] as Side[]) {
      const rows = buckets.filter(
        (bucket) => bucket.symbol === symbol && bucket.side === side && bucket.horizon === '60m',
      );
      const allowed = rows.filter(
        (row) =>
          (row.classification === 'strong_allow' || row.classification === 'allow') &&
          stableKeys.has(bucketKey(row)),
      );
      const avoid = rows.filter(
        (row) => row.classification === 'avoid' || row.classification === 'strong_avoid',
      );
      if (
        allowed.length === 0 &&
        rows.every((row) => row.count < DEFAULT_CALIBRATION_THRESHOLDS.insufficientCount)
      )
        continue;
      const allowedRegimes = allowed.map((row) => row.regime);
      const avoidRegimes = avoid.map((row) => row.regime);
      recommendations.push({
        symbol,
        side,
        allowedRegimes,
        avoidRegimes,
        confidence: allowed.length >= 2 ? 'high' : allowed.length === 1 ? 'medium' : 'low',
        reason:
          allowed.length > 0
            ? `${allowed.map((row) => `${row.regime} MFE/MAE=${formatNumber(row.mfeMaeRatio)} hit8=${formatPct(row.hit8BeforeMinus5Rate)}`).join('; ')}`
            : `No stable out-of-sample allow bucket; avoid ${avoidRegimes.slice(0, 4).join(', ') || 'none identified'}`,
      });
    }
  }
  return recommendations;
}

function thresholdGrid(): TechnicalRegimeThresholds[] {
  const adx = [16, 18, 20, 22, 25];
  const chop = [45, 50, 55, 60];
  const volume = [1.2, 1.3, 1.5, 1.8];
  const atr = [0.7, 0.8, 0.9];
  const exhaustion = [0.5, 0.6, 0.7];
  const breakout = [12, 18, 24, 36];
  const output: TechnicalRegimeThresholds[] = [];
  for (const minAdxForMomentum of adx) {
    for (const maxChoppinessForMomentum of chop) {
      for (const minVolumeRatioForMomentum of volume) {
        for (const maxAtrPercentileForAggressive of atr) {
          for (const maxExhaustionScore of exhaustion) {
            for (const breakoutLookback of breakout) {
              output.push({
                ...DEFAULT_TECHNICAL_REGIME_THRESHOLDS,
                minAdxForMomentum,
                maxChoppinessForMomentum,
                minVolumeRatioForMomentum,
                maxAtrPercentileForAggressive,
                maxExhaustionScore,
                breakoutLookback,
              });
            }
          }
        }
      }
    }
  }
  return output;
}

function scoreCandidate(
  thresholds: TechnicalRegimeThresholds,
  folds: WalkForwardFold[],
): RegimeCalibrationReport['thresholdCandidates'][number] {
  const testEdges = folds.map((fold) => fold.testEdge).filter(isNumber);
  const trainEdges = folds.map((fold) => fold.trainEdge).filter(isNumber);
  const decays = folds.map((fold) => fold.edgeDecay).filter(isNumber);
  const stableCount = folds.reduce((sum, fold) => sum + fold.stableBuckets.length, 0);
  const misleadingCount = folds.reduce((sum, fold) => sum + fold.misleadingBuckets.length, 0);
  const avgTestEdge = average(testEdges);
  return {
    rank: 0,
    score: (avgTestEdge ?? -1) + stableCount * 0.001 - misleadingCount * 0.002,
    thresholds,
    folds: folds.length,
    avgTrainEdge: average(trainEdges),
    avgTestEdge,
    avgEdgeDecay: average(decays),
  };
}

export async function writeCalibrationReports(
  report: RegimeCalibrationReport,
  reportsDir: string,
): Promise<RegimeCalibrationReport['outputFiles']> {
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15) + 'Z';
  const json = path.join(reportsDir, `aegis_regime_calibration_${stamp}.json`);
  const markdown = path.join(reportsDir, `aegis_regime_calibration_${stamp}.md`);
  const bucketsCsv = path.join(reportsDir, `aegis_regime_calibration_buckets_${stamp}.csv`);
  const walkForwardCsv = path.join(reportsDir, `aegis_regime_walkforward_${stamp}.csv`);
  const recommendationsMarkdown = path.join(
    reportsDir,
    `aegis_regime_momentum_recommendations_${stamp}.md`,
  );
  await fs.writeFile(json, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(markdown, renderCalibrationMarkdown(report), 'utf8');
  await fs.writeFile(bucketsCsv, renderBucketsCsv(report.buckets), 'utf8');
  await fs.writeFile(walkForwardCsv, renderWalkForwardCsv(report.walkForward), 'utf8');
  await fs.writeFile(recommendationsMarkdown, renderRecommendationsMarkdown(report), 'utf8');
  return { json, markdown, bucketsCsv, walkForwardCsv, recommendationsMarkdown };
}

export function renderCalibrationMarkdown(report: RegimeCalibrationReport): string {
  const best = report.buckets
    .filter(
      (bucket) =>
        bucket.horizon === '60m' &&
        (bucket.classification === 'strong_allow' || bucket.classification === 'allow'),
    )
    .sort((a, b) => (b.avgForwardReturnRoe ?? -Infinity) - (a.avgForwardReturnRoe ?? -Infinity))
    .slice(0, 20);
  const worst = report.buckets
    .filter(
      (bucket) =>
        bucket.horizon === '60m' &&
        (bucket.classification === 'avoid' || bucket.classification === 'strong_avoid'),
    )
    .sort((a, b) => (a.avgForwardReturnRoe ?? Infinity) - (b.avgForwardReturnRoe ?? Infinity))
    .slice(0, 20);
  return [
    '# Aegis Regime Detector Calibration',
    '',
    `Generated: ${report.generatedAt}`,
    `Window: ${report.options.from} -> ${report.options.to}`,
    `Walk-forward: train ${report.options.trainDays}d / test ${report.options.testDays}d / step ${report.options.stepDays}d`,
    '',
    '## Baseline Findings',
    '',
    ...(report.baseline?.currentGlobalFindings ?? []).map((item) => `- ${item}`),
    '',
    '## Best 60m Buckets',
    '',
    markdownBucketTable(best),
    '',
    '## Worst 60m Buckets',
    '',
    markdownBucketTable(worst),
    '',
    '## Walk-forward',
    '',
    markdownFoldTable(report.walkForward),
    '',
    '## Momentum Ride Recommendations',
    '',
    ...report.recommendations.map(
      (row) =>
        `- ${row.symbol} ${row.side}: allow [${row.allowedRegimes.join(', ') || 'none'}], avoid [${row.avoidRegimes.join(', ') || 'none'}], confidence=${row.confidence}. ${row.reason}`,
    ),
    '',
    '## Do Not Change Yet',
    '',
    '- Do not update regime_config.live.yaml automatically.',
    '- Do not move RegimeGuard to ENFORCE from this calibration alone.',
    '- Do not use global allowed regimes for every symbol without out-of-sample stability.',
    '',
  ].join('\n');
}

function renderRecommendationsMarkdown(report: RegimeCalibrationReport): string {
  return [
    '# Momentum Ride Regime Recommendations',
    '',
    ...report.recommendations.map((row) =>
      [
        `## ${row.symbol} ${row.side.toLowerCase()}`,
        '',
        `- allowed_regimes: [${row.allowedRegimes.join(', ') || 'none'}]`,
        `- avoid_regimes: [${row.avoidRegimes.join(', ') || 'none'}]`,
        `- confidence: ${row.confidence}`,
        `- reason: ${row.reason}`,
        '',
      ].join('\n'),
    ),
    'No YAML live changes were applied.',
    '',
  ].join('\n');
}

function renderBucketsCsv(rows: RegimeBucketCalibration[]): string {
  const header = [
    'symbol',
    'regime',
    'side',
    'horizon',
    'count',
    'avgForwardReturnRoe',
    'medianForwardReturnRoe',
    'avgMfeRoe',
    'avgMaeRoe',
    'mfeMaeRatio',
    'hit5BeforeMinus5Rate',
    'hit8BeforeMinus5Rate',
    'hit10BeforeMinus8Rate',
    'falseBreakoutRate',
    'avgTimeTo5Minutes',
    'avgTimeTo8Minutes',
    'avgTimeTo10Minutes',
    'worstMaeP75',
    'worstMaeP90',
    'worstMaeP95',
    'stabilityScore',
    'sampleQualityScore',
    'classification',
  ];
  return [
    header.join(','),
    ...rows.map((row) =>
      header.map((key) => csvValue((row as unknown as Record<string, unknown>)[key])).join(','),
    ),
  ].join('\n');
}

function renderWalkForwardCsv(rows: WalkForwardFold[]): string {
  const header = [
    'fold',
    'trainFrom',
    'trainTo',
    'testFrom',
    'testTo',
    'selectedBuckets',
    'trainEdge',
    'testEdge',
    'edgeDecay',
    'stableBuckets',
    'misleadingBuckets',
  ];
  return [
    header.join(','),
    ...rows.map((row) =>
      header
        .map((key) =>
          csvValue(
            Array.isArray((row as any)[key]) ? (row as any)[key].join(';') : (row as any)[key],
          ),
        )
        .join(','),
    ),
  ].join('\n');
}

function markdownBucketTable(rows: RegimeBucketCalibration[]): string {
  if (rows.length === 0) return 'N/D';
  return [
    '| bucket | count | ret60 | mfeMae | hit8 | p90Mae | class |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows.map(
      (row) =>
        `| ${bucketKey(row)} | ${row.count} | ${formatPct(row.avgForwardReturnRoe)} | ${formatNumber(row.mfeMaeRatio)} | ${formatPct(row.hit8BeforeMinus5Rate)} | ${formatPct(row.worstMaeP90)} | ${row.classification} |`,
    ),
  ].join('\n');
}

function markdownFoldTable(rows: WalkForwardFold[]): string {
  if (rows.length === 0) return 'N/D';
  return [
    '| fold | train | test | selected | trainEdge | testEdge | decay | stable | misleading |',
    '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.fold} | ${row.trainFrom.slice(0, 10)}..${row.trainTo.slice(0, 10)} | ${row.testFrom.slice(0, 10)}..${row.testTo.slice(0, 10)} | ${row.selectedBuckets} | ${formatPct(row.trainEdge)} | ${formatPct(row.testEdge)} | ${formatPct(row.edgeDecay)} | ${row.stableBuckets.length} | ${row.misleadingBuckets.length} |`,
    ),
  ].join('\n');
}

function summarizeGlobalFindings(report: DeepRegimeAuditReport): string[] {
  const up = report.byRegime.find((row) => row.bucket === 'MOMENTUM_UP' && row.horizon === '60m');
  const trend = report.byRegime.find((row) => row.bucket === 'TREND_UP' && row.horizon === '60m');
  const chop = report.byRegime.find((row) => row.bucket === 'CHOP' && row.horizon === '60m');
  const unknown = report.byRegime.find((row) => row.bucket === 'UNKNOWN' && row.horizon === '60m');
  return [
    `MOMENTUM_UP 60m: count=${up?.count ?? 0}, ret=${formatPct(up?.avgForwardReturnRoe)}, MFE/MAE=${formatNumber(up?.mfeMaeRatio)}, hit8=${formatPct(up?.hit8BeforeMinus5Rate)}`,
    `TREND_UP 60m: count=${trend?.count ?? 0}, ret=${formatPct(trend?.avgForwardReturnRoe)}, MFE/MAE=${formatNumber(trend?.mfeMaeRatio)}, hit8=${formatPct(trend?.hit8BeforeMinus5Rate)}`,
    `CHOP 60m: count=${chop?.count ?? 0}, ret=${formatPct(chop?.avgForwardReturnRoe)}, MFE/MAE=${formatNumber(chop?.mfeMaeRatio)}`,
    `UNKNOWN 60m: count=${unknown?.count ?? 0}, ret=${formatPct(unknown?.avgForwardReturnRoe)}, MFE/MAE=${formatNumber(unknown?.mfeMaeRatio)}`,
  ];
}

async function loadPreviousFindings(reportsDir: string): Promise<string[]> {
  try {
    const files = (await fs.readdir(reportsDir))
      .filter((file) => file.startsWith('aegis_regime_detector_audit_') && file.endsWith('.json'))
      .sort()
      .slice(-1);
    return files.length > 0
      ? [`Compared with previous audit file: ${path.join(reportsDir, files[0])}`]
      : [];
  } catch {
    return [];
  }
}

function stabilityFrom(row: DeepRegimeMetricRow): number {
  const ratioScore = Math.min(1, Math.max(0, ((row.mfeMaeRatio ?? 1) - 0.8) / 0.8));
  const hitScore = Math.min(1, Math.max(0, ((row.hit8BeforeMinus5Rate ?? 0) - 0.2) / 0.25));
  const sampleScore = Math.min(1, row.count / 100);
  return round((ratioScore + hitScore + sampleScore) / 3) ?? 0;
}

function bucketKey(row: Pick<RegimeBucketCalibration, 'symbol' | 'regime' | 'side'>): string {
  return `${row.symbol}|${row.regime}|${row.side}`;
}

function average(values: number[]): number | undefined {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
}

function positive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value: unknown, digits = 6): number | undefined {
  if (!isNumber(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatPct(value?: number): string {
  return value === undefined ? 'N/D' : `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value?: number): string {
  return value === undefined ? 'N/D' : value.toFixed(3);
}

function csvValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
