export type DirectionSignal = 'LONG' | 'SHORT' | null;

export type ProbabilityPair = {
  long: number;
  short: number;
};

export function resolveBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return fallback;
    return value !== 0;
  }
  return fallback;
}

export function parseTimeframeList(raw: unknown): string[] {
  const set = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) set.add(trimmed);
    }
  } else if (typeof raw === 'string') {
    for (const token of raw.split(/[,;]/)) {
      const trimmed = token.trim();
      if (trimmed) set.add(trimmed);
    }
  } else if (raw && typeof raw === 'object') {
    const value = (raw as { timeframe?: string }).timeframe;
    if (typeof value === 'string' && value.trim()) {
      set.add(value.trim());
    }
  }
  return Array.from(set);
}

export function resolveExtraTimeframes(
  params: { extra?: unknown; additional?: unknown },
  primary: string,
  defaults: string[] = ['15m'],
): string[] {
  const extras = parseTimeframeList(params.extra);
  const additional = parseTimeframeList(params.additional);
  const rawList = extras.length ? extras : additional;
  if (!rawList.length) {
    if (!defaults.length) return [];
    const primaryLower = primary.toLowerCase();
    return defaults.filter((tf) => tf.toLowerCase() !== primaryLower);
  }
  const primaryLower = primary.toLowerCase();
  return rawList.filter((tf) => tf.toLowerCase() !== primaryLower);
}

export function pickDirection(params: {
  longProb: number;
  shortProb: number;
  longThreshold: number;
  shortThreshold: number;
  margin: number;
}): DirectionSignal {
  const { longProb, shortProb, longThreshold, shortThreshold, margin } = params;
  const longGap = longProb - shortProb;
  const shortGap = shortProb - longProb;
  if (longProb >= longThreshold && longGap >= margin) {
    return 'LONG';
  }
  if (shortProb >= shortThreshold && shortGap >= margin) {
    return 'SHORT';
  }
  return null;
}

export function computeWeightedScore(
  primary: ProbabilityPair,
  extras: ProbabilityPair[],
  primaryWeight: number,
): number {
  const effectivePrimaryWeight = extras.length ? primaryWeight : 1;
  const extraWeight = extras.length ? (1 - effectivePrimaryWeight) / extras.length : 0;
  let score = (primary.long - primary.short) * effectivePrimaryWeight;
  for (const entry of extras) {
    score += (entry.long - entry.short) * extraWeight;
  }
  return score;
}
