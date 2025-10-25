import { Side } from '../core/types';

export function splitStrategyReason(reason: string | undefined, fallback: string) {
  if (!reason) {
    return { strategy: fallback, detail: '' };
  }
  const idx = reason.indexOf(':');
  if (idx === -1) {
    return { strategy: reason.split(/\s+/)[0] || fallback, detail: reason };
  }
  const strategy = reason.slice(0, idx) || fallback;
  const detail = reason.slice(idx + 1).trim();
  return { strategy, detail };
}

export function extractFilters(detail: string) {
  const filters: Record<string, unknown> = {};
  if (!detail) return filters;
  const tokens = detail.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const rawKey = token.slice(0, eq).replace(/[^a-zA-Z0-9_]/g, '');
    if (!rawKey) continue;
    const rawValueOriginal = token.slice(eq + 1).replace(/[;,]+$/, '');
    if (!rawValueOriginal) continue;
    if (/^(true|false)$/i.test(rawValueOriginal)) {
      filters[rawKey] = /^true$/i.test(rawValueOriginal);
      continue;
    }
    const sanitized = rawValueOriginal.replace(/%$/, '');
    const numeric = Number(sanitized);
    if (/^-?\d+(\.\d+)?$/.test(sanitized) && Number.isFinite(numeric)) {
      filters[rawKey] = numeric;
    } else {
      filters[rawKey] = rawValueOriginal;
    }
  }
  if (!Object.keys(filters).length) {
    filters.raw = detail;
  }
  return filters;
}

export function inferSideFromQty(qty?: number): Side {
  if (typeof qty === 'number') {
    if (qty > 0) return 'LONG';
    if (qty < 0) return 'SHORT';
  }
  return 'LONG';
}
