import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('PROSPECTIVE_CANONICALIZATION_FAILED');
  return encoded;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalUtc(value: string): string {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('PROSPECTIVE_TIMESTAMP_AMBIGUOUS');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('PROSPECTIVE_TIMESTAMP_INVALID');
  return new Date(parsed).toISOString();
}

export function requireSha256(value: string, code: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(code);
  return value;
}
