#!/usr/bin/env ts-node
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { CONFIG } from '../infra/config';
import { SqliteHistoricalSource } from './data/sqlite_source';
import { BacktestExchange } from './exchange';
import { BacktestEngine } from './engine';
import { resolveStrategy, listStrategies } from './strategy_loader';
import { resolveDataSymbol } from './symbols';

type CliArgs = {
  strategy: string;
  symbol: string;
  timeframe: string;
  dataSymbol?: string;
  db: string;
  env?: string;
  start?: string;
  end?: string;
  warmup?: number;
  tp?: number;
  sl?: number;
  trail?: number;
  fee?: number;
  maxHold?: number;
  verbose?: boolean;
};

function defaultDbPath(): string {
  return path.resolve(__dirname, '../../trading_system/data/xrp_trading.db');
}

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .scriptName('bt')
    .usage('$0 --strategy [name] [options]')
    .options({
      strategy: {
        type: 'string',
        demandOption: true,
        choices: listStrategies(),
        describe: 'Nombre de la estrategia a evaluar',
      },
      symbol: {
        type: 'string',
        default: CONFIG.SYMBOL || 'XRPUSDT',
        describe: 'Símbolo que utilizará la estrategia',
      },
      timeframe: {
        type: 'string',
        default: '5m',
        describe: 'Timeframe principal de candles',
      },
      dataSymbol: {
        type: 'string',
        describe: 'Símbolo dentro de la base SQLite (por defecto se infiere)',
      },
      db: {
        type: 'string',
        default: defaultDbPath(),
        describe: 'Ruta al SQLite con OHLCV e información de funding',
      },
      env: {
        type: 'string',
        describe: 'Archivo .env a cargar antes de inicializar el config',
      },
      start: {
        type: 'string',
        describe: 'Fecha inicio (ISO, ej. 2024-01-01)',
      },
      end: {
        type: 'string',
        describe: 'Fecha fin (ISO)',
      },
      warmup: {
        type: 'number',
        default: 400,
        describe: 'Barras de warmup antes de permitir operaciones',
      },
      tp: {
        type: 'number',
        describe: 'Take profit porcentual (ej. 0.01 = 1%)',
      },
      sl: {
        type: 'number',
        describe: 'Stop loss porcentual',
      },
      trail: {
        type: 'number',
        describe: 'Trailing stop porcentual',
      },
      fee: {
        type: 'number',
        default: 0.0004,
        describe: 'Fee estimado por lado (por defecto 0.04%)',
      },
      maxHold: {
        type: 'number',
        describe: 'Máximo de velas a mantener la posición',
      },
      verbose: {
        type: 'boolean',
        default: false,
        describe: 'Imprime tabla de trades individuales',
      },
    })
    .help()
    .parse()) as unknown as CliArgs;

  if (argv.env) {
    dotenv.config({ path: argv.env });
  } else {
    dotenv.config();
  }

  const strategy = resolveStrategy(argv.strategy);
  const dbPath = path.resolve(argv.db);
  const source = new SqliteHistoricalSource({ dbPath });
  const dataSymbol = resolveDataSymbol(argv.symbol, argv.dataSymbol);
  const exchange = new BacktestExchange({
    source,
    symbol: argv.symbol,
    dataSymbol,
    primaryTimeframe: argv.timeframe,
  });

  const engine = new BacktestEngine({
    source,
    exchange,
    strategy,
    config: CONFIG,
    options: {
      symbol: argv.symbol,
      timeframe: argv.timeframe,
      dataSymbol,
      startTime: argv.start,
      endTime: argv.end,
      warmupBars: argv.warmup,
      takeProfitPct: argv.tp,
      stopLossPct: argv.sl,
      trailingStopPct: argv.trail,
      tradeFeePct: argv.fee,
      maxHoldBars: argv.maxHold,
    },
  });

  try {
    const result = await engine.run();
    source.close();

    console.log('================ BACKTEST SUMMARY ================');
    console.log(`Strategy: ${argv.strategy}`);
    console.log(`Symbol  : ${argv.symbol}`);
    console.log(`TF      : ${argv.timeframe}`);
    console.log(`Trades  : ${result.summary.totalTrades}`);
    console.log(`WinRate : ${result.summary.winRatePct.toFixed(2)}%`);
    console.log(`AvgPnL  : ${result.summary.avgPnlPct.toFixed(4)}`);
    console.log(`Expect. : ${result.summary.expectancyPct.toFixed(4)}`);
    console.log(`Cumul.  : ${result.summary.cumPnlPct.toFixed(4)}`);
    console.log(`Best    : ${result.summary.bestPct.toFixed(4)} | Worst: ${result.summary.worstPct.toFixed(4)}`);
    console.log('=================================================');

    if (argv.verbose) {
      console.table(
        result.trades.map((trade) => ({
          id: trade.id,
          side: trade.side,
          entry: new Date(trade.entryTs).toISOString(),
          exit: new Date(trade.exitTs).toISOString(),
          pnl: trade.pnlPct.toFixed(4),
          mfe: trade.mfePct.toFixed(4),
          mae: trade.maePct.toFixed(4),
          bars: trade.barsHeld,
          reason: trade.exitReason,
        })),
      );
    } else {
      const sample = result.trades.slice(-5);
      if (sample.length) {
        console.log('Últimos trades:');
        for (const trade of sample) {
          console.log(
            `#${trade.id} ${trade.side} ${new Date(trade.entryTs).toISOString()} -> ${new Date(
              trade.exitTs,
            ).toISOString()} pnl=${trade.pnlPct.toFixed(4)} mfe=${trade.mfePct.toFixed(
              4,
            )} mae=${trade.maePct.toFixed(4)} reason=${trade.exitReason}`,
          );
        }
      }
    }
  } catch (err) {
    source.close();
    console.error('Backtest failed:', err);
    process.exit(1);
  }
}

main();
