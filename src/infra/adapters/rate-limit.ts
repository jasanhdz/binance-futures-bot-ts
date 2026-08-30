// src/infra/rate-limit.ts
let banUntil = 0;

export interface RateLimitDetails {
  status?: number;
  retryAfterMs?: number;
  banUntil?: number;
}

function extractBanUntil(msg: string): number | null {
  if (!msg) return null;
  const match = msg.match(/banned until (\d+)/i);
  if (match) {
    const ts = Number(match[1]);
    if (Number.isFinite(ts)) return ts;
  }
  if (/way too many requests/i.test(msg)) {
    return Date.now() + 60_000; // fallback 60s
  }
  return null;
}

function readRetryAfter(value: unknown, now: number): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds > now) return seconds - now;
  return seconds < 1_000 ? seconds * 1_000 : seconds;
}

export function parseRateLimitError(err: unknown, now = Date.now()): RateLimitDetails | null {
  const candidate = (err && typeof err === 'object' ? err : {}) as any;
  const status = Number(
    candidate.status ?? candidate.response?.status ?? candidate.response?.data?.status ?? candidate.code,
  );
  const message = String(candidate.message ?? candidate.err ?? candidate.response?.data?.msg ?? err ?? '');
  const retryAfter = readRetryAfter(
    candidate.retryAfter ?? candidate.response?.headers?.['retry-after'] ?? candidate.response?.data?.retryAfter,
    now,
  );
  const explicitBanUntil = extractBanUntil(message);
  if (![429, 418].includes(status) && retryAfter === null && explicitBanUntil === null) return null;
  const ban = explicitBanUntil ?? (retryAfter === null ? now + 60_000 : now + retryAfter);
  return {
    status: [429, 418].includes(status) ? status : undefined,
    retryAfterMs: retryAfter ?? Math.max(0, ban - now),
    banUntil: ban,
  };
}

export function getRateLimitUntil() {
  return banUntil;
}

export function noteRateLimitUntil(ts: number) {
  if (!Number.isFinite(ts)) return;
  if (ts > banUntil) {
    banUntil = ts;
  }
}

export function noteRateLimitFromError(err: unknown): number | null {
  const details = parseRateLimitError(err);
  const ts = details?.banUntil ?? null;
  if (ts) {
    noteRateLimitUntil(ts);
    return ts;
  }
  return null;
}

export function isRateLimited(now = Date.now()) {
  return now < banUntil;
}
