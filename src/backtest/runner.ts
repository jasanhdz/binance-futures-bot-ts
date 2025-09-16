#!/usr/bin/env ts-node
import 'dotenv/config';
import path from 'path';
import { statefulBacktest } from './engine';
import { loadCsvCandles } from './utils';
import { strategyMap } from './strategyMap';
import { parseCli } from './optsSchema';
import { analizaTrades } from './postAnalyzer';
import fs from 'fs';

async function main() {
  // 1. leer CLI
  const argv = parseCli();
  const {
    strategy: stratName,
    csv,
    symbol,
    interval,
    ...cfg // slPct, tpPct, feePct, leverage, maxBars, warmup, entryAt, antiLossThr, allowReverse, ...
  } = argv;

  // 2. cargar candles
  const candles = loadCsvCandles(csv);

  // 3. obtener clase
  const StrategyClass = strategyMap[stratName as keyof typeof strategyMap] as any;
  if (!StrategyClass) throw new Error(`Estrategia desconocida: ${stratName}`);

  // 4. instanciar (ya es una clase con .evaluate)
  const strategy = StrategyClass;

  // 5. backtest STATEFUL (una posición a la vez)
  const res = await statefulBacktest(strategy, candles, { symbol, interval, ...cfg });

  // 6. report
  console.log('\n===== SUMMARY (STATEFUL) =====');
  console.table([res.summary]);

  // 7. análisis post-BT
  const analisis = analizaTrades(res.trades);
  console.log('\nTop condiciones que hubieran evitado losers:');
  console.table(analisis.sugerencias.slice(0, 5));

  // 8. guardar JSON
  const outFile = path.resolve(__dirname, `../../train/bt_${stratName}_${symbol}_${interval}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ cfg, summary: res.summary, trades: res.trades, analisis }, null, 2),
  );
  console.log(`\n✅ Guardado → ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
