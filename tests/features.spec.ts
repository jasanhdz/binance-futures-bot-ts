import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { computeFeatures } from '../src/ml/features';
import type { Candle } from '../src/core/types';
import { it, expect } from 'vitest';

type Item = {
  window: Candle[];
  features_py: Record<
    'rsi' | 'ema_slope' | 'atr_pct' | 'vol_ratio' | 'body_pct' | 'wickiness' | 'mom3' | 'mom12',
    number
  >;
};

it('Py vs TS features are identical', () => {
  execFileSync('python3', ['train/export_sample_features.py', '--n', '120'], { stdio: 'inherit' });
  const p = path.resolve(__dirname, '../train/data/sample_XRPUSDT_5m.json');
  const data: Item[] = JSON.parse(fs.readFileSync(p, 'utf8'));
  let bad = 0;
  const keys = [
    'rsi',
    'ema_slope',
    'atr_pct',
    'vol_ratio',
    'body_pct',
    'wickiness',
    'mom3',
    'mom12',
  ] as const;
  for (const it of data) {
    const ts = computeFeatures(it.window);
    for (const k of keys) {
      const a = ts[k],
        b = it.features_py[k];
      const ad = Math.abs(a - b);
      const rd = Math.abs(ad / (Math.abs(b) > 1e-12 ? Math.abs(b) : 1));
      if (!(ad <= 1e-9 || rd <= 1e-6)) {
        bad++;
        break;
      }
    }
  }
  expect(bad).toBe(0);
});
