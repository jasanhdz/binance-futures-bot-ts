// verify_conditions.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Trade } from '../core/types';

const btFile = path.resolve(__dirname, '../../train/bt_StackClassic_XRPUSDT_5m.json');
const data = JSON.parse(fs.readFileSync(btFile, 'utf8'));
const trades: Trade[] = data.trades;

console.log('\n' + '='.repeat(70));
console.log('ANÁLISIS REAL DE CONDICIONES');
console.log('='.repeat(70));

const condiciones = [
  { name: 'mlMargin≥0.15', fn: (t: Trade) => t.mlMargin >= 0.15 },
  {
    name: 'hour∈[8..15]',
    fn: (t: Trade) => {
      const h = new Date(t.entryTs).getUTCHours();
      return h >= 8 && h <= 15;
    },
  },
  { name: 'vRatio≥1.5', fn: (t: Trade) => t.vRatio >= 1.5 },
  { name: 'mae≤0.5%', fn: (t: Trade) => t.maePct <= 0.005 },
  { name: 'distTopPct≥0.3%', fn: (t: Trade) => (t.distTopPct ?? 1) >= 0.003 },
  { name: 'adx≥25', fn: (t: Trade) => t.adx >= 25 },
];

// Stats originales
const totalTrades = trades.length;
const winnersOrig = trades.filter((t) => t.pnlPct > 0).length;
const losersOrig = trades.filter((t) => t.pnlPct <= 0).length;
const wrOrig = winnersOrig / totalTrades;

console.log(`\nOriginal: ${totalTrades} trades, ${winnersOrig} winners, ${losersOrig} losers`);
console.log(`WR Original: ${(wrOrig * 100).toFixed(1)}%\n`);

condiciones.forEach((cond) => {
  const pasan = trades.filter(cond.fn);
  const noPasan = trades.filter((t) => !cond.fn(t));

  const winnersPasan = pasan.filter((t) => t.pnlPct > 0).length;
  const losersPasan = pasan.filter((t) => t.pnlPct <= 0).length;
  const winnersNoPasan = noPasan.filter((t) => t.pnlPct > 0).length;
  const losersNoPasan = noPasan.filter((t) => t.pnlPct <= 0).length;

  const nuevoWR = pasan.length > 0 ? winnersPasan / pasan.length : 0;

  console.log(`📊 ${cond.name}`);
  console.log(`   Pasan filtro: ${pasan.length} trades (${winnersPasan}W / ${losersPasan}L)`);
  console.log(`   Descartados:  ${noPasan.length} trades (${winnersNoPasan}W / ${losersNoPasan}L)`);
  console.log(
    `   Nuevo WR: ${(nuevoWR * 100).toFixed(1)}% (${((nuevoWR - wrOrig) * 100).toFixed(1)}% cambio)`,
  );
  console.log(`   Balance: Evitas ${losersNoPasan} losers pero pierdes ${winnersNoPasan} winners`);
  console.log();
});
