import { Trade } from './engine';

type Condicion = { name: string; fn: (t: Trade) => boolean };
type Suggest = { cond: string; salvados: number; total: number; nuevoWR: number };

export function analizaTrades(trades: Trade[]) {
  const losers = trades.filter((t) => t.pnlPct <= 0);
  const winners = trades.filter((t) => t.pnlPct > 0);

  // --- 1. Frecuencia por hora ---
  const porHora = new Map<number, { n: number; w: number }>();
  trades.forEach((t) => {
    const h = new Date(t.entryTs).getUTCHours();
    const cur = porHora.get(h) ?? { n: 0, w: 0 };
    cur.n++;
    if (t.pnlPct > 0) cur.w++;
    porHora.set(h, cur);
  });

  // --- 2. Condiciones candidato para filtro ---
  const condiciones: Condicion[] = [
    { name: 'adx≥25', fn: (t) => t.adx >= 25 },
    { name: 'mlMargin≥0.15', fn: (t) => t.mlMargin >= 0.15 },
    { name: 'vRatio≥1.5', fn: (t) => t.vRatio >= 1.5 },
    { name: 'distTopPct≥0.3%', fn: (t) => (t.distTopPct ?? 1) >= 0.003 },
    {
      name: 'hour∈[8..15]',
      fn: (t) => {
        const h = new Date(t.entryTs).getUTCHours();
        return h >= 8 && h <= 15;
      },
    },
    { name: 'mae≤0.5%', fn: (t) => t.maePct <= 0.005 }, // buen timing
  ];

  const sugerencias: Suggest[] = [];
  condiciones.forEach((c) => {
    const dentro = trades.filter((t) => c.fn(t));
    const fuera = trades.filter((t) => !c.fn(t));
    const lDentro = dentro.filter((t) => t.pnlPct <= 0).length;
    const lFuera = fuera.filter((t) => t.pnlPct <= 0).length;
    const salvados = lFuera - lDentro;
    const nuevoWR =
      (winners.length - (dentro.length - dentro.filter((t) => t.pnlPct > 0).length)) /
      trades.length;
    sugerencias.push({
      cond: c.name,
      salvados,
      total: losers.length,
      nuevoWR: nuevoWR < 0 ? 0 : nuevoWR,
    });
  });

  // --- 3. Clusters de fallo (simple) ---
  const clusters: Record<string, number> = {};
  losers.forEach((t) => {
    const key = [
      t.adx < 20 ? 'adxBajo' : 'adxOk',
      t.vRatio < 1.0 ? 'volBajo' : 'volOk',
      (t.distTopPct ?? 1) < 0.002 ? 'cercaBB' : 'lejosBB',
    ].join('+');
    clusters[key] = (clusters[key] ?? 0) + 1;
  });

  return {
    porHora: Array.from(porHora.entries()).map(([h, v]) => ({ hour: h, ...v, wr: v.w / v.n })),
    sugerencias: sugerencias.sort((a, b) => b.salvados - a.salvados),
    clusters,
  };
}
