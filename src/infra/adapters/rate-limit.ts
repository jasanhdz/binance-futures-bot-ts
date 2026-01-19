// src/infra/rate-limit.ts
let banUntil = 0;

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
  const msg =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object'
        ? (err as any).message || (err as any).err || String(err)
        : String(err);
  const ts = extractBanUntil(msg);
  if (ts) {
    noteRateLimitUntil(ts);
    return ts;
  }
  return null;
}

export function isRateLimited(now = Date.now()) {
  return now < banUntil;
}
