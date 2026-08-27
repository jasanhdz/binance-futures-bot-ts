import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TECHNICAL_REGIME_THRESHOLDS,
  DeepRegimeMetricRow,
} from './regimeDetectorDeepAuditCore';
import {
  buildMomentumRecommendations,
  buildWalkForwardWindows,
  classifyBucket,
  RegimeBucketCalibration,
  RegimeCalibrationReport,
  writeCalibrationReports,
} from './regimeDetectorCalibrationCore';

function metricRow(overrides: Partial<DeepRegimeMetricRow> = {}): DeepRegimeMetricRow {
  return {
    bucket: 'ETHUSDT|BREAKOUT_UP|LONG',
    symbol: 'ETHUSDT',
    regime: 'BREAKOUT_UP',
    side: 'LONG',
    horizon: '60m',
    count: 60,
    avgForwardReturnRoe: 0.025,
    medianForwardReturnRoe: 0.018,
    avgMfeRoe: 0.12,
    avgMaeRoe: -0.07,
    mfeMaeRatio: 1.45,
    hit5BeforeMinus5Rate: 0.48,
    hit8BeforeMinus5Rate: 0.38,
    hit10BeforeMinus8Rate: 0.26,
    falseBreakoutRate: 0.18,
    avgTimeTo5Minutes: 20,
    avgTimeTo8Minutes: 35,
    avgTimeTo10Minutes: 45,
    worstMaeP75: 0.08,
    worstMaeP90: 0.14,
    worstMaeP95: 0.18,
    conclusion: 'good',
    ...overrides,
  };
}

function calibratedBucket(
  overrides: Partial<RegimeBucketCalibration> = {},
): RegimeBucketCalibration {
  return {
    symbol: 'ETHUSDT',
    regime: 'BREAKOUT_UP',
    side: 'LONG',
    horizon: '60m',
    count: 80,
    avgForwardReturnRoe: 0.03,
    medianForwardReturnRoe: 0.02,
    avgMfeRoe: 0.11,
    avgMaeRoe: -0.07,
    mfeMaeRatio: 1.28,
    hit5BeforeMinus5Rate: 0.5,
    hit8BeforeMinus5Rate: 0.36,
    hit10BeforeMinus8Rate: 0.24,
    falseBreakoutRate: 0.2,
    avgTimeTo5Minutes: 20,
    avgTimeTo8Minutes: 35,
    avgTimeTo10Minutes: 45,
    worstMaeP75: 0.08,
    worstMaeP90: 0.13,
    worstMaeP95: 0.18,
    stabilityScore: 0.75,
    sampleQualityScore: 0.8,
    classification: 'strong_allow',
    ...overrides,
  };
}

describe('regimeDetectorCalibrationCore', () => {
  it('clasifica buckets strong_allow, allow, avoid e insufficient_data', () => {
    expect(classifyBucket(metricRow())).toBe('strong_allow');
    expect(
      classifyBucket(
        metricRow({ count: 45, mfeMaeRatio: 1.12, hit8BeforeMinus5Rate: 0.31, worstMaeP90: 0.2 }),
      ),
    ).toBe('allow');
    expect(
      classifyBucket(
        metricRow({ mfeMaeRatio: 0.9, avgForwardReturnRoe: 0.01, hit8BeforeMinus5Rate: 0.25 }),
      ),
    ).toBe('avoid');
    expect(classifyBucket(metricRow({ count: 12 }))).toBe('insufficient_data');
  });

  it('crea ventanas walk-forward sin leakage entre train y test', () => {
    const windows = buildWalkForwardWindows(
      '2026-05-01T00:00:00.000Z',
      '2026-05-22T00:00:00.000Z',
      10,
      5,
      5,
    );

    expect(windows.length).toBe(2);
    expect(windows[0].trainTo).toBe(windows[0].testFrom);
    expect(Date.parse(windows[0].testTo)).toBeLessThanOrEqual(Date.parse(windows[1].trainTo));
    for (const window of windows) {
      expect(Date.parse(window.trainFrom)).toBeLessThan(Date.parse(window.trainTo));
      expect(Date.parse(window.trainTo)).toBe(Date.parse(window.testFrom));
      expect(Date.parse(window.testFrom)).toBeLessThan(Date.parse(window.testTo));
    }
  });

  it('no genera recomendacion Momentum si todos los buckets son muestra insuficiente', () => {
    const recommendations = buildMomentumRecommendations(
      [calibratedBucket({ count: 8, classification: 'insufficient_data' })],
      [],
    );

    expect(recommendations).toEqual([]);
  });

  it('genera recomendacion solo cuando el bucket allow es estable out-of-sample', () => {
    const recommendations = buildMomentumRecommendations(
      [
        calibratedBucket({ regime: 'BREAKOUT_UP', classification: 'allow' }),
        calibratedBucket({ regime: 'TREND_UP', classification: 'avoid', mfeMaeRatio: 0.88 }),
      ],
      [
        {
          fold: 1,
          trainFrom: '2026-05-01T00:00:00.000Z',
          trainTo: '2026-05-11T00:00:00.000Z',
          testFrom: '2026-05-11T00:00:00.000Z',
          testTo: '2026-05-16T00:00:00.000Z',
          selectedBuckets: 1,
          trainEdge: 0.02,
          testEdge: 0.015,
          edgeDecay: -0.005,
          stableBuckets: ['ETHUSDT|BREAKOUT_UP|LONG'],
          misleadingBuckets: [],
          thresholds: DEFAULT_TECHNICAL_REGIME_THRESHOLDS,
        },
      ],
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].allowedRegimes).toEqual(['BREAKOUT_UP']);
    expect(recommendations[0].avoidRegimes).toContain('TREND_UP');
  });

  it('escribe JSON, Markdown y CSV en directorio temporal sin tocar YAML live', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'regime-calibration-'));
    const yamlPath = path.join(process.cwd(), 'regime_config.live.yaml');
    const yamlBefore = await fs.readFile(yamlPath, 'utf8').catch(() => undefined);
    const report: RegimeCalibrationReport = {
      generatedAt: '2026-05-22T07:30:00.000Z',
      options: {
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-22T00:00:00.000Z',
        trainDays: 10,
        testDays: 5,
        stepDays: 5,
        sampleEvery: 6,
        leverage: 20,
        limitGrid: 1,
        reportsDir: tempDir,
        writeReports: true,
      },
      baseline: {
        previousGlobalFindings: [],
        currentGlobalFindings: ['CHOP remains neutral in test fixture'],
      },
      buckets: [calibratedBucket()],
      walkForward: [],
      thresholdCandidates: [],
      recommendations: [],
      warnings: [],
    };

    const files = await writeCalibrationReports(report, tempDir);

    expect(files?.json).toBeTruthy();
    expect(files?.markdown).toBeTruthy();
    expect(files?.bucketsCsv).toBeTruthy();
    expect(files?.walkForwardCsv).toBeTruthy();
    expect(files?.recommendationsMarkdown).toBeTruthy();
    await expect(fs.stat(files!.json)).resolves.toBeTruthy();
    await expect(fs.stat(files!.bucketsCsv)).resolves.toBeTruthy();
    if (yamlBefore !== undefined) {
      await expect(fs.readFile(yamlPath, 'utf8')).resolves.toBe(yamlBefore);
    }
  });
});
