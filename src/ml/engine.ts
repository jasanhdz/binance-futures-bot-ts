// src/core/ml/engine.ts
import { Candle } from '../core/types';
import { computeFeatures } from '../ml/features';
import { predictLong, predictShort } from '../ml/adapter';

export interface MLResult {
  longP: number;
  shortP: number;
}

export function evaluateML(cs: Candle[]): MLResult {
  const feats = computeFeatures(cs);
  return { longP: predictLong(feats), shortP: predictShort(feats) };
}
