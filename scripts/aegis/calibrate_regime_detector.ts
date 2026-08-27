#!/usr/bin/env ts-node
import {
  calibrateRegimeDetector,
  DEFAULT_CALIBRATION_THRESHOLDS,
  RegimeCalibrationOptions,
  renderCalibrationMarkdown,
} from '../../src/tooling/aegis/regimeDetectorCalibrationCore';
import { DEFAULT_DEEP_REGIME_SYMBOLS } from '../../src/tooling/aegis/regimeDetectorDeepAuditCore';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const report = await calibrateRegimeDetector(options);
  console.log(renderCalibrationMarkdown(report));
  if (report.outputFiles) {
    console.log('');
    console.log(`Reports: ${Object.values(report.outputFiles).join(', ')}`);
  }
}

type CliOptions = RegimeCalibrationOptions & { help?: boolean };

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    candlesDbPath: '/home/jasan/Develop/trading_system/data/binance_candles.db',
    reportsDir: '/home/jasan/Develop',
    symbols: DEFAULT_DEEP_REGIME_SYMBOLS,
    timeframe: '5m',
    trainDays: 14,
    testDays: 7,
    stepDays: 7,
    sampleEvery: 3,
    leverage: 20,
    limitGrid: 20,
    writeReports: true,
    thresholds: { ...DEFAULT_CALIBRATION_THRESHOLDS },
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => args[++index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--candles-db') options.candlesDbPath = next();
    else if (arg === '--reports-dir') options.reportsDir = next();
    else if (arg === '--symbols') options.symbols = splitCsv(next());
    else if (arg === '--timeframe') options.timeframe = next();
    else if (arg === '--from') options.from = next();
    else if (arg === '--to') options.to = next();
    else if (arg === '--train-days') options.trainDays = Number(next());
    else if (arg === '--test-days') options.testDays = Number(next());
    else if (arg === '--step-days') options.stepDays = Number(next());
    else if (arg === '--sample-every') options.sampleEvery = Number(next());
    else if (arg === '--leverage') options.leverage = Number(next());
    else if (arg === '--limit-grid') options.limitGrid = Number(next());
    else if (arg === '--strong-min-count')
      options.thresholds = { ...options.thresholds, strongMinCount: Number(next()) };
    else if (arg === '--strong-min-mfemae')
      options.thresholds = { ...options.thresholds, strongMinMfeMae: Number(next()) };
    else if (arg === '--strong-min-hit8')
      options.thresholds = { ...options.thresholds, strongMinHit8: Number(next()) };
    else if (arg === '--allow-min-count')
      options.thresholds = { ...options.thresholds, allowMinCount: Number(next()) };
    else if (arg === '--allow-min-mfemae')
      options.thresholds = { ...options.thresholds, allowMinMfeMae: Number(next()) };
    else if (arg === '--allow-min-hit8')
      options.thresholds = { ...options.thresholds, allowMinHit8: Number(next()) };
    else if (arg === '--insufficient-count')
      options.thresholds = { ...options.thresholds, insufficientCount: Number(next()) };
    else if (arg === '--no-reports') options.writeReports = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function splitCsv(value?: string): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function helpText(): string {
  return [
    'Aegis regime detector calibration and walk-forward audit',
    '',
    'Usage:',
    '  ts-node scripts/aegis/calibrate_regime_detector.ts [options]',
    '',
    'Options:',
    '  --candles-db PATH          Read-only SQLite candles DB',
    '  --reports-dir PATH         Output directory, default /home/jasan/Develop',
    '  --symbols CSV              Symbols to calibrate',
    '  --timeframe 5m             OHLCV timeframe',
    '  --from ISO                 Start timestamp',
    '  --to ISO                   End timestamp',
    '  --train-days N             Walk-forward train window, default 14',
    '  --test-days N              Walk-forward test window, default 7',
    '  --step-days N              Walk-forward step, default 7',
    '  --sample-every N           Sample every N candles, default 3',
    '  --leverage N               ROE leverage proxy, default 20',
    '  --limit-grid N             Max technical threshold candidates, default 20',
    '  --strong-min-count N       strong_allow minimum count',
    '  --strong-min-mfemae N      strong_allow minimum MFE/MAE',
    '  --strong-min-hit8 N        strong_allow minimum hit +8 before -5',
    '  --allow-min-count N        allow minimum count',
    '  --allow-min-mfemae N       allow minimum MFE/MAE',
    '  --allow-min-hit8 N         allow minimum hit +8 before -5',
    '  --insufficient-count N     insufficient_data count cutoff',
    '  --no-reports               Print only, write no files',
    '',
    'Read-only: does not call Binance, PM2, bot runtime, orders, .env, or live YAML writes.',
  ].join('\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
