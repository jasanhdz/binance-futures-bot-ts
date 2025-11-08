#!/usr/bin/env ts-node
import path from 'path';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { CONFIG as BASE_CONFIG } from '../infra/config';
import { SqliteHistoricalSource } from './data/sqlite_source';
import { BacktestExchange } from './exchange';
import { BacktestEngine } from './engine';
import { resolveDataSymbol } from './symbols';
import { MlProbabilityStrategy } from '../strategies/ml_probability';

type CliArgs = {
  symbol: string;
  timeframe: string;
  dataSymbol?: string;
  db: string;
  env?: string;
  start?: string;
  end?: string;
  warmup: number;
  tp?: number;
  sl?: number;
  trail?: number;
  fee: number;
  maxHold?: number;
  serviceUrl?: string;
  timeout?: number;
  history?: number;
  verbose: boolean;
  override: string[];
};

function defaultDbPath(): string {
  return path.resolve(__dirname, '../../trading_system/data/xrp_trading.db');
}

function cloneConfig<T>(config: T): T {
  return JSON.parse(JSON.stringify(config));
}

function parseOverrideValue(raw: string): unknown {
  const lowered = raw.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  if (raw === '') return raw;
  const num = Number(raw);
  if (Number.isFinite(num)) return num;
  return raw;
}

function applyOverrides(config: Record<string, unknown>, overrides: string[]) {
  for (const entry of overrides) {
    const [key, ...rest] = entry.split('=');
    if (!key) continue;
    const valueRaw = rest.join('=');
    if (valueRaw === undefined) continue;
    config[key.trim()] = parseOverrideValue(valueRaw.trim());
  }
}

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .scriptName('bt:ml')
    .usage('$0 [options]')
    .options({
      env: {
        type: 'string',
        describe: 'Archivo .env a cargar (por defecto intenta .env)',
      },
      symbol: {
        type: 'string',
        default: BASE_CONFIG.SYMBOL || 'XRPUSDT',
        describe: 'Símbolo a backtestear',
      },
      timeframe: {
        type: 'string',
        default: '5m',
        describe: 'Timeframe principal',
      },
      dataSymbol: {
        type: 'string',
        describe: 'Símbolo dentro de la base de datos (se infiere si se omite)',
      },
      db: {
        type: 'string',
        default: defaultDbPath(),
        describe: 'Ruta al archivo SQLite con OHLCV/Funding',
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
        describe: 'Velas de warmup antes de operar',
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
        describe: 'Fee estimado por lado',
      },
      maxHold: {
        type: 'number',
        describe: 'Máximo de velas que se mantiene una posición',
      },
      serviceUrl: {
        type: 'string',
        describe: 'URL del servicio ML (sobrescribe ML_SERVICE_URL)',
      },
      timeout: {
        type: 'number',
        describe: 'Timeout del servicio ML en ms',
      },
      history: {
        type: 'number',
        describe: 'Barras base de historia para el modelo',
      },
      override: {
        type: 'string',
        array: true,
        default: [],
        describe: 'Sobrescribir config del bot, formato CLAVE=VALOR (se puede repetir)',
      },
      verbose: {
        type: 'boolean',
        default: false,
        describe: 'Imprime tabla de trades completos',
      },
    })
    .help()
    .parse()) as unknown as CliArgs;

  if (argv.env) {
    dotenv.config({ path: argv.env });
  } else {
    dotenv.config();
  }

  if (argv.serviceUrl) {
    process.env.ML_SERVICE_URL = argv.serviceUrl;
  }

  const config = cloneConfig(BASE_CONFIG) as Record<string, unknown>;
  applyOverrides(config, argv.override);

  const strategy = new MlProbabilityStrategy({
    timeframe: argv.timeframe,
    historyBars: argv.history,
    serviceUrl: argv.serviceUrl,
    timeoutMs: argv.timeout,
  });

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
    config,
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

    console.log('================ ML BACKTEST SUMMARY ================');
    console.log(`Symbol  : ${argv.symbol}`);
    console.log(`TF      : ${argv.timeframe}`);
    console.log(`Trades  : ${result.summary.totalTrades}`);
    console.log(`WinRate : ${result.summary.winRatePct.toFixed(2)}%`);
    console.log(`AvgPnL  : ${result.summary.avgPnlPct.toFixed(4)}`);
    console.log(`Expect. : ${result.summary.expectancyPct.toFixed(4)}`);
    console.log(`Cumul.  : ${result.summary.cumPnlPct.toFixed(4)}`);
    console.log(`Best    : ${result.summary.bestPct.toFixed(4)} | Worst: ${result.summary.worstPct.toFixed(4)}`);
    console.log('=====================================================');

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
    console.error('ML backtest failed:', err);
    process.exit(1);
  }
}

main();
