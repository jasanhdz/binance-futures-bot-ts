import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { StrategyName, strategyMap } from './strategyMap';

const defaultsByStrategy: Record<StrategyName, any> = {
  StackClassic: {
    slPct: 0.005,
    tpPct: 0.01,
    feePct: 0.0006,
    leverage: 100,
    maxBars: 12,
    warmup: 200,
    entryAt: 'nextOpen',
  },
  StackPro: {
    slPct: 0.005,
    tpPct: 0.01,
    feePct: 0.0006,
    leverage: 100,
    maxBars: 12,
    warmup: 120,
    entryAt: 'nextOpen',
  },
  MeanReversion: {
    rsiLen: 14,
    width: 0.002,
    tpPct: 0.008,
    slPct: 0.006,
    feePct: 0.0006,
    leverage: 100,
    maxBars: 10,
    warmup: 50,
    entryAt: 'nextOpen',
  },
};

export function parseCli() {
  const argv = yargs(hideBin(process.argv))
    .option('strategy', { type: 'string', demandOption: true, choices: Object.keys(strategyMap) })
    .option('csv', { type: 'string', default: '' })
    .option('symbol', { type: 'string', default: process.env.SYMBOL ?? 'XRPUSDT' })
    .option('interval', { type: 'string', default: process.env.INTERVAL ?? '5m' })
    .parseSync();

  const strategy = argv.strategy as StrategyName;
  const base = defaultsByStrategy[strategy];

  // sobrescribir con cualquier flag extra
  Object.keys(base).forEach((k) => {
    if (k in argv) (base as any)[k] = (argv as any)[k];
  });

  const csv =
    argv.csv || `${process.cwd()}/train/data/raw_klines_${argv.symbol}_${argv.interval}.csv`;

  return { strategy, csv, symbol: argv.symbol, interval: argv.interval, ...base };
}
