import fs from 'fs';
import path from 'path';

type Scaler = { mean: Record<string, number>; std: Record<string, number> };
type Coeffs = { coefficients: number[]; intercept: number };

export type FeatureVec = Record<
  'rsi' | 'ema_slope' | 'atr_pct' | 'vol_ratio' | 'body_pct' | 'wickiness' | 'mom3' | 'mom12',
  number
>;

const dataDir = path.resolve(__dirname, '../../data');

function loadJSON<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')) as T;
}

const scalerLong: Scaler = loadJSON('scaler_long.json');
const scalerShort: Scaler = loadJSON('scaler_short.json');
const modelLong: Coeffs = loadJSON('model_coeffs_long.json');
const modelShort: Coeffs = loadJSON('model_coeffs_short.json');

const FEATS: (keyof FeatureVec)[] = [
  'rsi',
  'ema_slope',
  'atr_pct',
  'vol_ratio',
  'body_pct',
  'wickiness',
  'mom3',
  'mom12',
];

function z(features: FeatureVec, scaler: Scaler) {
  return FEATS.map(
    (f) => (features[f] - (scaler.mean[f] ?? 0)) / Math.max(1e-9, scaler.std[f] ?? 1),
  );
}
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function predictLong(features: FeatureVec): number {
  const x = z(features, scalerLong);
  const dot = modelLong.coefficients.reduce((s, w, i) => s + w * x[i], modelLong.intercept);
  return sigmoid(dot);
}
export function predictShort(features: FeatureVec): number {
  const x = z(features, scalerShort);
  const dot = modelShort.coefficients.reduce((s, w, i) => s + w * x[i], modelShort.intercept);
  return sigmoid(dot);
}
