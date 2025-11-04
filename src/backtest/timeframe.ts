const UNIT_MAP: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function timeframeToMs(tf: string): number {
  const match = /^(\d+)([smhd])$/i.exec(tf.trim());
  if (!match) {
    throw new Error(`Unsupported timeframe: ${tf}`);
  }
  const value = Number(match[1]);
  const unit = UNIT_MAP[match[2].toLowerCase()];
  if (!Number.isFinite(value) || !unit) {
    throw new Error(`Invalid timeframe: ${tf}`);
  }
  return value * unit;
}
