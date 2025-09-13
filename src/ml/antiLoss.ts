// src/ml/antiLoss.ts
import * as ort from 'onnxruntime-node';
import path from 'path';

const FEAT_ORDER = ['adx', 'mlMargin', 'vRatio', 'distTopPct', 'hour'] as const;
type AntiLossFeatures = Record<(typeof FEAT_ORDER)[number], number>;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    const modelPath = path.join(__dirname, '../../models/antiLoss_rf.onnx');
    sessionPromise = ort.InferenceSession.create(modelPath);
  }
  return sessionPromise;
}

export async function predictLoss(f: AntiLossFeatures): Promise<number> {
  const sess = await getSession();

  const vec = FEAT_ORDER.map((k) => (Number.isFinite(f[k]) ? Number(f[k]) : 0));
  const input = new ort.Tensor('float32', Float32Array.from(vec), [1, vec.length]);

  const inputName = sess.inputNames[0];

  // Intenta encontrar explícitamente las probabilidades
  const probName =
    sess.outputNames.find((n) => n.toLowerCase().includes('prob')) ??
    sess.outputNames.find((n) => n.toLowerCase().includes('output')) ??
    // fallback: a veces probabilities es el último
    sess.outputNames[sess.outputNames.length - 1];

  const out = await sess.run({ [inputName]: input });

  // Preferimos probabilities
  let tensor = out[probName];
  let data = tensor?.data as Float32Array | Int32Array | BigInt64Array | undefined;

  // Caso A: [1,2] → [p0, p1]
  if (tensor && tensor.dims.length === 2 && tensor.dims[0] === 1 && tensor.dims[1] === 2 && data) {
    const arr = Array.from(data as Float32Array).map(Number);
    return Math.max(0, Math.min(1, arr[1] ?? arr[0]));
  }

  // Si el "probName" apuntó a label por error, probamos el otro
  const altName = sess.outputNames.find((n) => n !== probName);
  if (altName) {
    const alt = out[altName];
    if (alt && alt.dims.length === 2 && alt.dims[0] === 1 && alt.dims[1] === 2) {
      const arr = Array.from(alt.data as Float32Array);
      return Math.max(0, Math.min(1, Number(arr[1] ?? arr[0])));
    }
    if (alt && (alt.data as any)?.length === 1) {
      const v = Number((alt.data as any)[0]);
      // Si viniera un label 0/1, úsalo como prob (peor caso)
      return v === 0 || v === 1 ? v : Math.max(0, Math.min(1, v));
    }
  }

  // Caso B: prob escalar
  if (tensor && data && (data as any).length === 1) {
    const v = Number((data as any)[0]);
    return v === 0 || v === 1 ? v : Math.max(0, Math.min(1, v));
  }

  throw new Error('antiLoss: no pude leer "probabilities" del modelo ONNX');
}
