import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { PullbackTrade } from './MicroBurstPullbackCandidate';

export interface ArchiveSegment {
  filePath: string;
  checksum: string;
  recordCount: number;
}
export interface ArchiveEvent {
  symbol: string;
  type: 'trades' | 'depth';
  eventTime: number;
  receivedAtMs: number;
  payload: Record<string, unknown>;
}

export interface UnverifiedPullbackEvidence {
  coverageVerified: boolean;
  coverageStartedAtMs: number;
  coverageThroughMs: number;
  gapFree: boolean;
  sequenceValid: boolean;
  capacityTruncated: boolean;
  invalidReason: string | null;
  trades: readonly PullbackTrade[];
}

/** Checks stored bytes/counts before returning any rows. No best-effort malformed parsing. */
export function readVerifiedSegments(segments: readonly ArchiveSegment[]): ArchiveEvent[] {
  return segments.flatMap((segment) => {
    const bytes = gunzipSync(readFileSync(segment.filePath));
    const text = bytes.toString('utf8');
    if (
      createHash('sha256').update(bytes).digest('hex') !== segment.checksum ||
      !text.endsWith('\n')
    )
      throw new Error('ARCHIVE_CHECKSUM_OR_TERMINATION_INVALID');
    const lines = text.slice(0, -1).split('\n');
    if (lines.length !== segment.recordCount) throw new Error('ARCHIVE_RECORD_COUNT_INVALID');
    return lines.map((line) => {
      const row = JSON.parse(line) as ArchiveEvent;
      if (
        !row.symbol ||
        !['trades', 'depth'].includes(row.type) ||
        ![row.eventTime, row.receivedAtMs].every((n) => Number.isFinite(n) && n > 0) ||
        !row.payload ||
        row.payload.eventTime !== row.eventTime ||
        row.payload.receivedAtMs !== row.receivedAtMs ||
        row.payload.symbol !== row.symbol
      )
        throw new Error('ARCHIVE_ENVELOPE_INVALID');
      return row;
    });
  });
}

export interface CaptureCoverage {
  symbol: string;
  /** A capture-session manifest, not first/last observed trade timestamps. */
  fromMs: number;
  throughMs: number;
  gaps: readonly { fromMs: number; throughMs: number }[];
}

export function causalTradeEvidence(
  events: readonly ArchiveEvent[],
  coverage: CaptureCoverage,
  exchangeAsOfMs: number,
  receivedAsOfMs: number,
): UnverifiedPullbackEvidence {
  const start = exchangeAsOfMs - 60_000;
  const validCoverage =
    [coverage.fromMs, coverage.throughMs, exchangeAsOfMs, receivedAsOfMs].every(Number.isFinite) &&
    coverage.fromMs <= start &&
    coverage.throughMs >= exchangeAsOfMs;
  const gapFree = !coverage.gaps.some(
    (gap) =>
      ![gap.fromMs, gap.throughMs].every(Number.isFinite) ||
      gap.fromMs > gap.throughMs ||
      (gap.fromMs <= exchangeAsOfMs && gap.throughMs >= start),
  );
  const visible = events
    .filter(
      (e) =>
        e.type === 'trades' &&
        e.symbol === coverage.symbol &&
        e.eventTime <= exchangeAsOfMs &&
        e.receivedAtMs <= receivedAsOfMs,
    )
    .sort(
      (a, b) =>
        a.eventTime - b.eventTime ||
        Number(a.payload.aggregateTradeId) - Number(b.payload.aggregateTradeId),
    );
  const trades: PullbackTrade[] = [];
  let sequenceValid = true;
  let previousId: number | undefined;
  let anchor = false;
  const identities = new Map<number, string>();
  for (const event of visible) {
    const p = event.payload;
    const t: PullbackTrade = {
      aggregateTradeId: Number(p.aggregateTradeId),
      eventTime: event.eventTime,
      receivedAtMs: event.receivedAtMs,
      price: Number(p.price),
      quantity: Number(p.quantity),
      isBuyerMaker: p.isBuyerMaker as boolean,
    };
    const fingerprint = JSON.stringify([t.eventTime, t.price, t.quantity, t.isBuyerMaker]);
    if (identities.has(t.aggregateTradeId)) {
      if (identities.get(t.aggregateTradeId) !== fingerprint) sequenceValid = false;
      continue;
    }
    identities.set(t.aggregateTradeId, fingerprint);
    if (
      !Number.isSafeInteger(t.aggregateTradeId) ||
      t.aggregateTradeId < 0 ||
      ![t.price, t.quantity].every((n) => Number.isFinite(n) && n > 0) ||
      typeof t.isBuyerMaker !== 'boolean'
    )
      sequenceValid = false;
    if (t.eventTime < start) {
      previousId = t.aggregateTradeId;
      anchor = true;
      continue;
    }
    if (previousId === undefined || t.aggregateTradeId !== previousId + 1) sequenceValid = false;
    previousId = t.aggregateTradeId;
    trades.push(t);
  }
  const invalidReason = !validCoverage
    ? 'CAPTURE_SESSION_RANGE_MISSING'
    : !gapFree
      ? 'ARCHIVED_FEED_GAP'
      : !anchor
        ? 'PREWINDOW_ANCHOR_MISSING'
        : !sequenceValid
          ? 'TRADE_SEQUENCE_INVALID'
          : null;
  return {
    coverageVerified: validCoverage && anchor && sequenceValid && gapFree,
    coverageStartedAtMs: coverage.fromMs,
    coverageThroughMs: coverage.throughMs,
    gapFree,
    sequenceValid,
    capacityTruncated: false,
    invalidReason,
    trades,
  };
}

export interface DepthCheckpoint {
  symbol: string;
  /** Local receive time of the book state represented by this checkpoint. */
  receivedAtMs: number;
  /** Earliest local time at which this persisted checkpoint was available to replay. */
  availableAtMs?: number;
  lastUpdateId: number;
  bids: readonly { price: number; qty: number }[];
  asks: readonly { price: number; qty: number }[];
}

export interface CausalDepthReplay {
  readonly status: 'VERIFIED' | 'UNKNOWN';
  readonly reason?:
    | 'INVALID_DEPTH_CHECKPOINT'
    | 'DEPTH_EVENT_INVALID'
    | 'DEPTH_RECEIVE_CLOCK_REGRESSION'
    | 'DEPTH_EVENT_TIME_REGRESSION'
    | 'DEPTH_DUPLICATE_CONFLICT'
    | 'DEPTH_SEQUENCE_GAP'
    | 'DEPTH_BOOK_INVALID'
    | 'DEPTH_TOO_OLD'
    | 'DEPTH_NO_UPDATES_OBSERVED';
  readonly book?: {
    bidDepth: { price: number; qty: number }[];
    askDepth: { price: number; qty: number }[];
    observedAtMs: number;
    lastUpdateId: number;
    appliedEventCount: number;
  };
}

/**
 * Reconstructs only the depth state supported by the supplied checkpoint and every
 * causally visible USD-M update. Event time and local receive time are independent
 * clocks; neither is substituted for the other.
 */
export function replayCausalDepth(
  checkpoint: DepthCheckpoint,
  events: readonly ArchiveEvent[],
  clocks: { exchangeAsOfMs: number; receivedAsOfMs: number },
  maxAgeMs: number,
  requireUpdate = false,
): CausalDepthReplay {
  const { exchangeAsOfMs, receivedAsOfMs } = clocks;
  const availableAtMs = checkpoint.availableAtMs ?? checkpoint.receivedAtMs;
  if (
    ![exchangeAsOfMs, receivedAsOfMs, maxAgeMs, checkpoint.receivedAtMs, availableAtMs].every(
      Number.isFinite,
    ) ||
    maxAgeMs <= 0 ||
    checkpoint.receivedAtMs > receivedAsOfMs ||
    availableAtMs > receivedAsOfMs ||
    availableAtMs < checkpoint.receivedAtMs ||
    !Number.isSafeInteger(checkpoint.lastUpdateId) ||
    checkpoint.lastUpdateId < 0 ||
    !checkpoint.bids.length ||
    !checkpoint.asks.length
  )
    return { status: 'UNKNOWN', reason: 'INVALID_DEPTH_CHECKPOINT' };
  const valid = (levels: DepthCheckpoint['bids'], descending: boolean) =>
    levels.every(
      (level, index) =>
        Number.isFinite(level.price) &&
        level.price > 0 &&
        Number.isFinite(level.qty) &&
        level.qty >= 0 &&
        (index === 0 ||
          (descending
            ? levels[index - 1].price > level.price
            : levels[index - 1].price < level.price)),
    );
  if (
    !valid(checkpoint.bids, true) ||
    !valid(checkpoint.asks, false) ||
    checkpoint.bids[0].price > checkpoint.asks[0].price
  )
    return { status: 'UNKNOWN', reason: 'INVALID_DEPTH_CHECKPOINT' };
  const bids = new Map(checkpoint.bids.map((l) => [l.price, l.qty]));
  const asks = new Map(checkpoint.asks.map((l) => [l.price, l.qty]));
  const floor = Math.min(...bids.keys());
  const ceiling = Math.max(...asks.keys());
  let last = checkpoint.lastUpdateId;
  let observedAtMs = checkpoint.receivedAtMs;
  let appliedEventCount = 0;
  const identities = new Map<string, string>();
  const finalUpdateIdentities = new Map<number, { identity: string; fingerprint: string }>();
  const visible = events
    .filter(
      (e) =>
        e.type === 'depth' &&
        e.symbol === checkpoint.symbol &&
        e.receivedAtMs >= availableAtMs &&
        e.receivedAtMs <= receivedAsOfMs &&
        e.eventTime <= exchangeAsOfMs,
    )
    .slice();
  const pending: Array<{
    event: ArchiveEvent;
    U: number;
    u: number;
    pu: number;
    identity: string;
    fingerprint: string;
  }> = [];
  for (const event of visible) {
    const p = event.payload;
    const U = Number(p.U),
      u = Number(p.u),
      pu = Number(p.pu);
    if (
      ![U, u, pu].every(Number.isSafeInteger) ||
      U < 0 ||
      u < U ||
      pu < 0 ||
      !Number.isFinite(event.receivedAtMs) ||
      !Number.isFinite(event.eventTime) ||
      p.symbol !== event.symbol ||
      p.eventTime !== event.eventTime ||
      p.receivedAtMs !== event.receivedAtMs
    )
      return { status: 'UNKNOWN', reason: 'DEPTH_EVENT_INVALID' };
    const identity = `${U}:${u}:${pu}`;
    const fingerprint = JSON.stringify([event.eventTime, p.b, p.a]);
    const previousIdentity = identities.get(identity);
    if (previousIdentity !== undefined) {
      if (previousIdentity !== fingerprint)
        return { status: 'UNKNOWN', reason: 'DEPTH_DUPLICATE_CONFLICT' };
      continue;
    }
    identities.set(identity, fingerprint);
    pending.push({ event, U, u, pu, identity, fingerprint });
  }
  let previousReceiveAtMs = availableAtMs;
  let previousEventAtMs = -Infinity;
  while (pending.length) {
    for (let index = pending.length - 1; index >= 0; index--) {
      const update = pending[index];
      if (update.u > last) continue;
      const previousFinal = finalUpdateIdentities.get(update.u);
      if (
        previousFinal &&
        (previousFinal.identity !== update.identity ||
          previousFinal.fingerprint !== update.fingerprint)
      )
        return { status: 'UNKNOWN', reason: 'DEPTH_DUPLICATE_CONFLICT' };
      pending.splice(index, 1);
    }
    if (!pending.length) break;
    const applicable = pending.filter(
      (update) => update.pu === last && update.U <= last + 1 && update.u >= last + 1,
    );
    if (applicable.length !== 1) return { status: 'UNKNOWN', reason: 'DEPTH_SEQUENCE_GAP' };
    const update = applicable[0];
    const event = update.event;
    if (event.receivedAtMs < previousReceiveAtMs)
      return { status: 'UNKNOWN', reason: 'DEPTH_RECEIVE_CLOCK_REGRESSION' };
    if (event.eventTime < previousEventAtMs)
      return { status: 'UNKNOWN', reason: 'DEPTH_EVENT_TIME_REGRESSION' };
    previousReceiveAtMs = event.receivedAtMs;
    previousEventAtMs = event.eventTime;
    const p = event.payload;
    for (const [raw, map, bound] of [
      [p.b, bids, (price: number) => price >= floor],
      [p.a, asks, (price: number) => price <= ceiling],
    ] as const) {
      if (!Array.isArray(raw)) return { status: 'UNKNOWN', reason: 'DEPTH_EVENT_INVALID' };
      for (const level of raw) {
        if (!Array.isArray(level) || level.length !== 2)
          return { status: 'UNKNOWN', reason: 'DEPTH_EVENT_INVALID' };
        const price = Number(level[0]),
          qty = Number(level[1]);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 0)
          return { status: 'UNKNOWN', reason: 'DEPTH_EVENT_INVALID' };
        if (bound(price)) {
          if (qty === 0) map.delete(price);
          else map.set(price, qty);
        }
      }
    }
    last = update.u;
    finalUpdateIdentities.set(update.u, {
      identity: update.identity,
      fingerprint: update.fingerprint,
    });
    observedAtMs = event.receivedAtMs;
    appliedEventCount++;
    pending.splice(pending.indexOf(update), 1);
  }
  if (receivedAsOfMs - observedAtMs > maxAgeMs)
    return { status: 'UNKNOWN', reason: 'DEPTH_TOO_OLD' };
  if (requireUpdate && appliedEventCount === 0)
    return { status: 'UNKNOWN', reason: 'DEPTH_NO_UPDATES_OBSERVED' };
  const bidDepth = [...bids]
    .filter(([, q]) => q > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([price, qty]) => ({ price, qty }));
  const askDepth = [...asks]
    .filter(([, q]) => q > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([price, qty]) => ({ price, qty }));
  if (!bidDepth.length || !askDepth.length || bidDepth[0].price > askDepth[0].price)
    return { status: 'UNKNOWN', reason: 'DEPTH_BOOK_INVALID' };
  return {
    status: 'VERIFIED',
    book: { bidDepth, askDepth, observedAtMs, lastUpdateId: last, appliedEventCount },
  };
}

/** Compatibility point query. Paired replay uses replayCausalDepth directly. */
export function causalExecutionBook(
  checkpoint: DepthCheckpoint,
  events: readonly ArchiveEvent[],
  now: number,
  maxAgeMs: number,
): {
  bidDepth: { price: number; qty: number }[];
  askDepth: { price: number; qty: number }[];
  observedAtMs: number;
} | null {
  const result = replayCausalDepth(
    checkpoint,
    events,
    { exchangeAsOfMs: Number.MAX_SAFE_INTEGER, receivedAsOfMs: now },
    maxAgeMs,
  );
  if (result.status !== 'VERIFIED' || !result.book) return null;
  return {
    bidDepth: result.book.bidDepth,
    askDepth: result.book.askDepth,
    observedAtMs: result.book.observedAtMs,
  };
}

export function depthVwap(
  levels: readonly { price: number; qty: number }[],
  quantity: number,
): number | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  let remaining = quantity,
    notional = 0;
  for (const level of levels) {
    if (
      !Number.isFinite(level.price) ||
      level.price <= 0 ||
      !Number.isFinite(level.qty) ||
      level.qty < 0
    )
      return null;
    const take = Math.min(remaining, level.qty);
    notional += take * level.price;
    remaining -= take;
    if (remaining <= 1e-12) return notional / quantity;
  }
  return null;
}
