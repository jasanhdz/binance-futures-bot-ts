// src/tools/momentum_scanner.ts
import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import path from 'path';
import Binance from 'binance-api-node';
import { CONFIG } from '../infra/config';
import { Logger } from '../core/ports/Logger';
import { scanSymbols, StrategyCandidate, SymbolScanResult } from '../scanner/analyzer';
import { Candle } from '../core/types';
import { FundingSnapshot, BasisSnapshot } from '../core/ports/Exchange';
import { getTrendSignals } from '../strategies/shared/context';

class CliLogger implements Logger {
  debug(msg: string, ctx?: any): void {
    if (process.env.SCANNER_DEBUG === '1') console.debug(`[debug] ${msg}`, ctx ?? '');
  }
  info(msg: string, ctx?: any): void {
    console.log(`[info] ${msg}`, ctx ?? '');
  }
  warn(msg: string, ctx?: any): void {
    console.warn(`[warn] ${msg}`, ctx ?? '');
  }
  error(msg: string, ctx?: any): void {
    console.error(`[error] ${msg}`, ctx ?? '');
  }
}

const DEFAULT_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'TRXUSDT',
  'DOTUSDT',
  'MATICUSDT',
  'LTCUSDT',
  'BCHUSDT',
  'FILUSDT',
  'ATOMUSDT',
  'NEARUSDT',
  'APTUSDT',
  'SUIUSDT',
  'OPUSDT',
  'ARBUSDT',
];

async function fetchTopSymbols(limit = 150): Promise<string[]> {
  try {
    const client = Binance({
      apiKey: CONFIG.API_KEY || undefined,
      apiSecret: CONFIG.API_SECRET || undefined,
      httpFutures: CONFIG.HTTP_FUTURES,
      wsFutures: CONFIG.WS_FUTURES,
    });
    const stats = (await client.futuresDailyStats()) as any[];
    const filtered = stats.filter((s: any) => {
      const sym = String(s.symbol ?? '');
      if (!sym.endsWith('USDT')) return false;
      if (sym.includes('_')) return false;
      if (sym.startsWith('BTCDOM')) return false;
      const quote = Number(s.quoteVolume ?? s.volume ?? 0);
      const baseVol = Number(s.volume ?? 0);
      if (!Number.isFinite(quote) || quote < 100_000_000) return false;
      if (!Number.isFinite(baseVol) || baseVol < 10_000_000) return false;
      if (Number.isFinite(s.priceChangePercent) && Math.abs(Number(s.priceChangePercent)) > 250)
        return false;
      return true;
    });
    filtered.sort((a: any, b: any) => {
      const av = Number(a.quoteVolume ?? a.volume ?? 0);
      const bv = Number(b.quoteVolume ?? b.volume ?? 0);
      return bv - av;
    });
    const top = filtered.slice(0, limit).map((s: any) => String(s.symbol));
    if (top.length) return top;
  } catch (err) {
    console.warn('top_symbol_fetch_failed', err);
  }
  return DEFAULT_SYMBOLS.slice();
}

function parseSymbolList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

function printSupporting(symbol: string, candidates: StrategyCandidate[], minScore: number, best: StrategyCandidate) {
  const supporting = candidates
    .filter((c) => c !== best && c.score >= minScore - 5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  supporting.forEach((cand) => {
    const formattedScore = (cand.score / 100).toFixed(4);
    console.log(
      `    ↳ ${symbol} ${cand.strategy} ${cand.side} score=${formattedScore} ready=${
        cand.ready ? 'yes' : 'no'
      } ${cand.detail}`,
    );
  });
}

function renderTable(rows: Array<{
  rank: number;
  symbol: string;
  best: StrategyCandidate;
  metrics: { pullbackDepthPct: number; bounceDistancePct: number };
  extras: { lastClose: number; shortSma: number; longSma: number; trendStrengthPct: number };
}>) {
  const headers = [
    'Rank',
    'Symbol',
    'Strategy',
    'Side',
    'Score',
    'TrendStrengthPct',
    'PullbackDepthPct',
    'BounceDistancePct',
    'Qualifies',
    'LatestClose',
    'ShortSma',
    'LongSma',
  ];

  const data = rows.map((row) => {
    const score = row.best.score / 100;
    return [
      String(row.rank),
      row.symbol,
      row.best.strategy,
      row.best.side,
      formatNumber(score, 4),
      formatNumber(row.extras.trendStrengthPct, 2),
      formatNumber(row.metrics.pullbackDepthPct, 2),
      formatNumber(row.metrics.bounceDistancePct, 2),
      row.best.ready ? 'true' : 'false',
      formatNumber(row.extras.lastClose, 4),
      formatNumber(row.extras.shortSma, 4),
      formatNumber(row.extras.longSma, 4),
    ];
  });

  const colWidths = headers.map((header, idx) =>
    Math.max(
      header.length,
      ...data.map((row) => row[idx].length),
    ),
  );

  const formatRow = (row: string[]) =>
    '│ ' +
    row
      .map((value, idx) => value.padEnd(colWidths[idx], ' '))
      .join(' │ ') +
    ' │';

  const headerLine =
    '┌ ' +
    headers
      .map((header, idx) => header.padEnd(colWidths[idx], ' '))
      .join(' ┬ ') +
    ' ┐';
  const separator =
    '├ ' +
    colWidths
      .map((width) => '─'.repeat(width))
      .join(' ┼ ') +
    ' ┤';
  const footer =
    '└ ' +
    colWidths
      .map((width) => '─'.repeat(width))
      .join(' ┴ ') +
    ' ┘';

  console.log(headerLine);
  console.log(
    '│ ' +
      headers
        .map((header, idx) => header.padEnd(colWidths[idx], ' '))
        .join(' │ ') +
      ' │',
  );
  console.log(separator);
  data.forEach((row) => console.log(formatRow(row)));
  console.log(footer);
}

function saveResults(results: SymbolScanResult[]) {
  const dir = path.resolve(process.cwd(), 'data', 'scans');
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:]/g, '-');
  const file = path.join(dir, `scan_${timestamp}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2), 'utf8');
  logInfo('Saved full scan results', { path: file });
}

const logPrefix = () => {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
};

function logInfo(message: string, ctx?: Record<string, unknown>) {
  if (ctx) console.log(`${logPrefix()} [INFO] ${message} ${JSON.stringify(ctx)}`);
  else console.log(`${logPrefix()} [INFO] ${message}`);
}

function formatNumber(value: number, digits = 2) {
  if (!Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function deriveMetrics(res: SymbolScanResult) {
  const { best, analyses } = res;
  let pullback = 0;
  let bounce = 0;

  if (!best) return { pullbackDepthPct: 0, bounceDistancePct: 0 };

  if (best.strategy === 'range_breakout' && analyses.rangeBreakout) {
    const state =
      best.side === 'LONG' ? analyses.rangeBreakout.long : analyses.rangeBreakout.short;
    pullback = Math.abs((state.rangeWidthPct ?? 0) * 100);
    bounce = Math.abs((state.atrPct ?? 0) * 100);
  } else if (best.strategy === 'break_retest' && analyses.breakRetest) {
    const state = best.side === 'LONG' ? analyses.breakRetest.long : analyses.breakRetest.short;
    if (state.breakoutLevel && state.last) {
      const ref = best.side === 'LONG' ? state.last.low : state.last.high;
      if (typeof ref === 'number' && Number.isFinite(ref)) {
        const depth = Math.abs(state.breakoutLevel - (ref as number));
        pullback = state.breakoutLevel !== 0 ? (depth / Math.abs(state.breakoutLevel)) * 100 : 0;
      }
    }
    bounce = Math.abs((state.roomPct ?? 0) * 100);
  } else if (best.strategy === 'liquidity_sweep' && analyses.liquiditySweep) {
    const state =
      best.side === 'LONG' ? analyses.liquiditySweep.long : analyses.liquiditySweep.short;
    pullback = Math.abs((state.levelDistance ?? 0) * 100);
    bounce = Math.abs((state.wickRatio ?? 0) * 100);
  } else if (best.strategy === 'snapback' && analyses.snap) {
    const state = best.side === 'LONG' ? analyses.snap.long : analyses.snap.short;
    pullback = Math.abs(state.extension * 100);
    bounce = Math.abs(state.extension * 100);
  } else if (best.strategy === 'volume_profile' && analyses.volumeProfile) {
    const state =
      best.side === 'LONG' ? analyses.volumeProfile.long : analyses.volumeProfile.short;
    pullback = Math.abs((state.distancePct ?? 0) * 100);
    const vah = analyses.volumeProfile.valueAreaHigh;
    const val = analyses.volumeProfile.valueAreaLow;
    if (Number.isFinite(vah) && Number.isFinite(val) && vah !== val) {
      const span = Math.abs(vah - val);
      const poc = Number.isFinite(analyses.volumeProfile.poc) ? Math.abs(analyses.volumeProfile.poc) : 1;
      bounce = (span / Math.max(poc, 1e-6)) * 100;
    }
  } else if (best.strategy === 'trend_ride' && analyses.trendRide) {
    const state = best.side === 'LONG' ? analyses.trendRide.long : analyses.trendRide.short;
    const span = state.keltnerUpper - state.keltnerLower;
    const denom = Number.isFinite(state.emaSlow) ? Math.abs(state.emaSlow) : 1;
    pullback = Math.abs((span / Math.max(denom, 1e-6)) * 100);
    bounce = Math.abs(state.slope * 1000);
  } else if (best.strategy === 'funding_basis' && analyses.fundingBasis) {
    const state =
      best.side === 'LONG' ? analyses.fundingBasis.long : analyses.fundingBasis.short;
    pullback = Math.abs(state.fundingRate * 100);
    bounce = Math.abs(state.basisPct * 100);
  }

  return {
    pullbackDepthPct: pullback,
    bounceDistancePct: bounce,
  };
}

function computeTrendStrengthPct(signals: ReturnType<typeof getTrendSignals>): number {
  const fast = signals.emaFast;
  const slow = signals.emaSlow;
  if (!Number.isFinite(fast) || !Number.isFinite(slow) || slow === 0) return 0;
  return ((fast - slow) / Math.abs(slow)) * 100;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('symbols', {
      type: 'string',
      describe: 'Comma separated list of USDT perpetual symbols to scan (e.g. BTCUSDT,ETHUSDT)',
    })
    .option('limit', {
      type: 'number',
      describe: 'How many top results to display',
      default: 25,
    })
    .option('side', {
      type: 'string',
      choices: ['LONG', 'SHORT', 'BOTH'],
      describe: 'Filter output by preferred side',
      default: 'BOTH',
    })
    .option('minscore', {
      type: 'number',
      describe: 'Minimum score threshold to display',
      default: 20,
    })
    .option('save', {
      type: 'boolean',
      describe: 'Save full scan results to data/scans',
      default: false,
    })
    .help()
    .parse();

  const logger = new CliLogger();
  const client = Binance({
    apiKey: CONFIG.API_KEY || undefined,
    apiSecret: CONFIG.API_SECRET || undefined,
    httpFutures: CONFIG.HTTP_FUTURES,
    wsFutures: CONFIG.WS_FUTURES,
  });

  let symbols: string[] = [];
  const cliSymbols = parseSymbolList(argv.symbols);
  const envSymbols = parseSymbolList(process.env.SCANNER_SYMBOLS);
  const configSymbols = CONFIG.SYMBOLS && CONFIG.SYMBOLS.length ? CONFIG.SYMBOLS : [];

  if (cliSymbols.length) symbols = cliSymbols;
  else if (envSymbols.length) symbols = envSymbols;
  else symbols = await fetchTopSymbols(150);

  symbols = Array.from(new Set([...symbols, ...configSymbols])).slice(0, 150);

  const source = cliSymbols.length
    ? 'cli'
    : envSymbols.length
      ? 'env'
      : configSymbols.length
        ? 'config'
        : 'top200';

  try {
    const server = await client.futuresTime();
    const offset = Number(server) - Date.now();
    logInfo('Synchronized clock with Binance', { offset });
  } catch (err) {
    logInfo('Failed to sync clock', { err: (err as any)?.message || String(err) });
  }

  if (!cliSymbols.length && !envSymbols.length && !configSymbols.length) {
    logInfo('Fetching top futures symbols by volume.');
  } else {
    logInfo(`Using ${symbols.length} configured symbols (source=${source}).`);
  }

  logInfo('scanner_start', { symbols: symbols.length, source, timeframe: CONFIG.ENTRY_TIMEFRAME });

  logInfo(`Evaluating strategies for ${symbols.length} symbols.`);

  const candlesFetcher = async (symbol: string, interval: string, limit: number): Promise<Candle[]> => {
    const raw = await client.futuresCandles({ symbol, interval: interval as any, limit });
    return raw.map((c) => ({
      openTime: c.openTime,
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: +c.volume,
      closeTime: c.closeTime,
    }));
  };

  const fundingFetcher = async (symbol: string): Promise<FundingSnapshot> => {
    const data = await client.futuresFundingRate({ symbol, limit: 1 });
    const entry = Array.isArray(data) && data.length ? data[0] : undefined;
    const rate = entry && entry.fundingRate !== undefined ? Number(entry.fundingRate) : NaN;
    const nextFundingTime = entry && entry.fundingTime !== undefined ? Number(entry.fundingTime) : undefined;
    return { rate, nextFundingTime };
  };

  const basisFetcher = async (symbol: string): Promise<BasisSnapshot> => {
    const markData = await client.futuresMarkPrice();
    const entry = Array.isArray(markData)
      ? (markData.find((r: any) => r.symbol === symbol) as any)
      : (markData as any);
    const markPrice = entry && entry.markPrice !== undefined ? Number(entry.markPrice) : NaN;
    const indexPrice = entry && entry.indexPrice !== undefined ? Number(entry.indexPrice) : NaN;
    const basisPct =
      Number.isFinite(markPrice) && Number.isFinite(indexPrice) && indexPrice !== 0
        ? (markPrice - indexPrice) / Math.abs(indexPrice)
        : NaN;
    return { markPrice, indexPrice, basisPct };
  };

  const ranked = await scanSymbols({
    candlesFetcher,
    fundingFetcher,
    basisFetcher,
    symbols,
    config: CONFIG,
    sideFilter: (argv.side ?? 'BOTH') as 'LONG' | 'SHORT' | 'BOTH',
    minScore: argv.minscore!,
    limit: argv.limit!,
    logger,
  });

  if (!ranked.length) {
    logInfo('No symbols met the minimum score threshold.');
    return;
  }

  const rows = ranked.map((res, idx) => {
    const metrics = deriveMetrics(res);
    return {
      rank: idx + 1,
      symbol: res.symbol,
      best: res.best!,
      candidates: res.candidates,
      metrics,
      extras: res.extras,
    };
  });

  const readyCount = rows.filter((row) => row.best.ready).length;
  logInfo(`Found ${readyCount} qualifying candidates.`);

  const topRows = rows.slice(0, Math.min(argv.limit!, rows.length));

  console.log('\nTop candidates by score:');
  renderTable(topRows);

  const qualifying = topRows.filter((row) => row.best.ready);
  if (qualifying.length) {
    console.log(`\nQualifying candidates (max ${qualifying.length}):`);
    renderTable(qualifying);
  }

  topRows.forEach((row) => printSupporting(row.symbol, row.candidates, argv.minscore!, row.best));

  if (argv.save) {
    saveResults(ranked);
  }
}

main().catch((err) => {
  console.error('Scanner failed:', err);
  process.exitCode = 1;
});
