// src/ml/check_features.ts
import fs from 'fs';
import path from 'path';
import { computeFeatures } from './features';

type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

type Row = {
  window?: Candle[]; // ahora siempre presente
  candle?: Candle; // informativo
  features_py: Record<string, number>;
};

const FEATS = [
  'rsi',
  'ema_slope',
  'atr_pct',
  'vol_ratio',
  'body_pct',
  'wickiness',
  'mom3',
  'mom12',
] as const;

const EPS: Record<(typeof FEATS)[number], number> = {
  rsi: 1e-6,
  ema_slope: 1e-6, // deja un pelín más alto por floating en distintas plataformas
  atr_pct: 1e-9,
  vol_ratio: 1e-9,
  body_pct: 1e-12,
  wickiness: 1e-12,
  mom3: 1e-12,
  mom12: 1e-12,
};

const file = process.argv[2] || path.resolve(__dirname, '../../train/data/sample_XRPUSDT_5m.json');
const rows: Row[] = JSON.parse(fs.readFileSync(file, 'utf8'));

let ok = 0,
  bad = 0;
const mae: Record<string, number> = Object.fromEntries(FEATS.map((f) => [f, 0]));

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const win = r.window;

  if (!Array.isArray(win) || win.length < 40) {
    console.warn(`fila ${i}: ventana ausente/insuficiente (${win?.length ?? 0}), omito`);
    continue;
  }

  const tsFeat: any = computeFeatures(win as Candle[]);
  const pyFeat = r.features_py;

  let allGood = true;
  for (const k of FEATS) {
    const a = tsFeat[k];
    const b = pyFeat[k];
    const diff = Math.abs(a - b);
    mae[k] += diff;
    if (!Number.isFinite(a) || !Number.isFinite(b) || diff > EPS[k]) {
      allGood = false;
    }
  }
  allGood ? ok++ : bad++;
}

for (const k of FEATS) mae[k] = rows.length ? mae[k] / rows.length : 0;

console.log(`OK=${ok} BAD=${bad}`);
console.log('MAE por feature:', mae);
process.exit(bad ? 1 : 0);
