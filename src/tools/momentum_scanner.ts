// src/tools/momentum_scanner.ts
import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { BinanceExchange } from '../infra/binance/BinanceExchange';
import { CONFIG } from '../infra/config';
import { MomentumBreakout, MOMENTUM_TIMEFRAME, analyzeMomentumBreakout } from '../strategies/momentum_breakout';
import { Logger } from '../core/ports/Logger';
import { MomentumAnalysis, MomentumDirectionState } from '../strategies/momentum_breakout';

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

type DirectionScore = {
  side: 'LONG' | 'SHORT';
  score: number;
  state: MomentumDirectionState;
};

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

function directionScore(analysis: MomentumAnalysis, state: MomentumDirectionState): number {
  if (!Number.isFinite(state.triggerPrice) || !Number.isFinite(state.baseLevel)) return 0;
  let score = 0;

  const streakRatio =
    analysis.params.streakMin > 0 ? Math.min(1, state.streak / analysis.params.streakMin) : 0;
  score += streakRatio * 25;

  const volRatio =
    analysis.params.volFactor > 0
      ? Math.min(state.weakestVolRatio / analysis.params.volFactor, 1)
      : 0;
  score += volRatio * 20;

  if (state.trendOk) score += 25;
  if (state.breakoutOk) score += 10;

  const dist = state.priceToTriggerPct;
  if (Number.isFinite(dist)) {
    const window = 0.003; // 0.3%
    const closeness = Math.max(0, (window - Math.max(0, dist)) / window);
    score += closeness * 20;
  }

  if (state.ready) score += 20;

  return Math.min(100, score);
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
      default: 10,
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
    .help()
    .parse();

  const logger = new CliLogger();
  const exchange = new BinanceExchange(logger);

  const rawSymbols =
    argv.symbols ??
    process.env.SCANNER_SYMBOLS ??
    DEFAULT_SYMBOLS.join(',');
  const symbols = rawSymbols
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  const confirmTf = (CONFIG as any).MOM_TREND_CONFIRM_TF ?? '15m';
  if (!['3m', '5m', '15m', '1h'].includes(confirmTf)) {
    throw new Error(`Unsupported confirm timeframe ${confirmTf}`);
  }

  const results: Array<{
    symbol: string;
    analysis: MomentumAnalysis;
    longScore: number;
    shortScore: number;
    best: DirectionScore;
    alternate: DirectionScore;
  }> = [];

  logger.info('scanner_start', {
    symbols: symbols.length,
    timeframe: MomentumBreakout.timeframe,
    confirmTf,
  });

  for (const symbol of symbols) {
    try {
      const candles = await exchange.getCandles(symbol, MOMENTUM_TIMEFRAME, 320);
      if (candles.length < 80) {
        logger.warn('skip_symbol_insufficient_data', { symbol, candles: candles.length });
        continue;
      }

      const confirmCandles =
        confirmTf === MOMENTUM_TIMEFRAME
          ? candles
          : await exchange.getCandles(symbol, confirmTf, 320);

      const analysis = analyzeMomentumBreakout({
        candles,
        confirmCandles,
        config: CONFIG,
        confirmTf,
      });

      const longScore = directionScore(analysis, analysis.long);
      const shortScore = directionScore(analysis, analysis.short);

      const best =
        longScore >= shortScore
          ? { side: 'LONG' as const, score: longScore, state: analysis.long }
          : { side: 'SHORT' as const, score: shortScore, state: analysis.short };
      const alternate =
        best.side === 'LONG'
          ? { side: 'SHORT' as const, score: shortScore, state: analysis.short }
          : { side: 'LONG' as const, score: longScore, state: analysis.long };

      results.push({ symbol, analysis, longScore, shortScore, best, alternate });
    } catch (err: any) {
      logger.warn('scan_error', { symbol, err: err?.message ?? String(err) });
    }
  }

  results.sort((a, b) => b.best.score - a.best.score);

  const limit = Number.isFinite(argv.limit) ? Math.max(1, argv.limit!) : 10;
  const showSide = (argv.side ?? 'BOTH') as 'LONG' | 'SHORT' | 'BOTH';
  const filtered = results.filter((res) => {
    if (res.best.score < argv.minscore!) return false;
    if (showSide === 'BOTH') return true;
    return res.best.side === showSide && res.best.score >= argv.minscore!;
  });

  if (filtered.length === 0) {
    console.log('No symbols met the minimum score threshold.');
    return;
  }

  console.log(
    `Momentum breakout readiness — timeframe=${MomentumBreakout.timeframe} confirm=${confirmTf} — ${new Date().toISOString()}`,
  );

  filtered.slice(0, limit).forEach((res, idx) => {
    const { best, alternate, analysis } = res;
    const state = best.state;
    const distPct = Number.isFinite(state.priceToTriggerPct)
      ? (state.priceToTriggerPct * 100).toFixed(2)
      : 'n/a';
    const baseLevel = Number.isFinite(state.baseLevel) ? state.baseLevel.toFixed(4) : 'n/a';
    const trigger = Number.isFinite(state.triggerPrice)
      ? state.triggerPrice.toFixed(4)
      : 'n/a';
    const volx = Number.isFinite(state.weakestVolRatio)
      ? state.weakestVolRatio.toFixed(2)
      : 'n/a';
    const adxNow = Number.isFinite(analysis.trendNow.adx)
      ? analysis.trendNow.adx.toFixed(1)
      : 'n/a';
    const flags = [
      state.streakOk ? 'streak✓' : `streak${state.streak}/${analysis.params.streakMin}`,
      state.trendOk ? 'trend✓' : 'trend✗',
      state.breakoutOk ? 'breakout✓' : `dist${distPct}%`,
    ].join(' ');

    console.log(
      `${String(idx + 1).padStart(2, ' ')}. ${res.symbol.padEnd(9, ' ')} score=${best.score
        .toFixed(1)
        .padStart(5, ' ')} side=${best.side.padEnd(5, ' ')} price=${analysis.lastCandle.close
        .toFixed(4)
        .padEnd(10, ' ')} trigger=${trigger} level=${baseLevel} dist=${distPct}% volx=${volx} adx=${adxNow} ${flags}`,
    );

    if (alternate.score >= argv.minscore! && showSide === 'BOTH') {
      const alt = alternate.state;
      const altDist = Number.isFinite(alt.priceToTriggerPct)
        ? (alt.priceToTriggerPct * 100).toFixed(2)
        : 'n/a';
      console.log(
        `    ↳ alt ${alternate.side} score=${alternate.score.toFixed(1)} dist=${altDist}% streak=${alt.streak} trend=${alt.trendOk ? 'yes' : 'no'} ready=${alt.ready ? 'yes' : 'no'}`,
      );
    }
  });

  const readyNow = filtered.filter((res) => res.best.state.ready);
  if (readyNow.length) {
    console.log('\nSymbols currently signalling (ready=true):');
    readyNow.forEach((res) => {
      console.log(
        ` - ${res.symbol} ${res.best.side} score=${res.best.score.toFixed(1)} price=${res.analysis.lastCandle.close.toFixed(4)}`,
      );
    });
  }
}

main().catch((err) => {
  console.error('Scanner failed:', err);
  process.exitCode = 1;
});
