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

export interface DepthKnowledgeBounds {
  readonly bidFloor: number;
  readonly askCeiling: number;
}

/** Public REST snapshot and the archived diff buffer present while its snapshot sync completed. */
export interface RestDepthSnapshotAnchor {
  readonly symbol: string;
  readonly requestedAtMs: number;
  readonly snapshotReceivedAtMs: number;
  readonly availableAtMs: number;
  readonly exchangeUpperBoundAtAvailableMs: number;
  readonly lastUpdateId: number;
  readonly bids: readonly { price: number; qty: number }[];
  readonly asks: readonly { price: number; qty: number }[];
  readonly bufferLengthBefore: number;
  readonly bufferLengthAfter: number;
  readonly bufferedEvents: readonly ArchiveEvent[];
  readonly evidenceSha256: string;
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
  /** Original known depth bounds; they may exceed surviving edge levels. */
  knownDepthBounds?: DepthKnowledgeBounds;
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
    | 'DEPTH_NO_UPDATES_OBSERVED'
    | 'REST_DEPTH_SNAPSHOT_INVALID'
    | 'REST_DEPTH_SNAPSHOT_BUFFER_UNVERIFIED'
    | 'REST_DEPTH_SNAPSHOT_BUFFER_COUNT_MISMATCH'
    | 'REST_DEPTH_SNAPSHOT_BRIDGE_MISSING'
    | 'REST_DEPTH_SNAPSHOT_BRIDGE_INVALID'
    | 'REST_DEPTH_SNAPSHOT_BUFFER_SEQUENCE_GAP'
    | 'REST_DEPTH_SNAPSHOT_AFTER_DECISION_BOUND';
  readonly book?: {
    bidDepth: { price: number; qty: number }[];
    askDepth: { price: number; qty: number }[];
    observedAtMs: number;
    lastUpdateId: number;
    appliedEventCount: number;
    knownDepthBounds: DepthKnowledgeBounds;
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
  const floor = checkpoint.knownDepthBounds?.bidFloor ?? Math.min(...bids.keys());
  const ceiling = checkpoint.knownDepthBounds?.askCeiling ?? Math.max(...asks.keys());
  if (
    !Number.isFinite(floor) ||
    !Number.isFinite(ceiling) ||
    floor <= 0 ||
    ceiling <= 0 ||
    floor > Math.min(...bids.keys()) ||
    ceiling < Math.max(...asks.keys())
  )
    return { status: 'UNKNOWN', reason: 'INVALID_DEPTH_CHECKPOINT' };
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
      // USD-M `pu` links this update to the checkpoint/previous update. `U` is
      // a range boundary and can start above last+1 even when the `pu` chain is intact.
      (update) => update.pu === last && update.u >= last + 1,
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
    book: {
      bidDepth,
      askDepth,
      observedAtMs,
      lastUpdateId: last,
      appliedEventCount,
      knownDepthBounds: { bidFloor: floor, askCeiling: ceiling },
    },
  };
}

/**
 * Replays the captured USD-M snapshot bridge exactly as SynchronizedOrderBook does:
 * REST snapshot first, then its pre-response diff buffer, then pu-linked live updates.
 */
export function replayCausalDepthFromBufferedRestSnapshot(
  anchor: RestDepthSnapshotAnchor,
  events: readonly ArchiveEvent[],
  clocks: { exchangeAsOfMs: number; receivedAsOfMs: number; exchangeLowerBoundMs?: number },
  maxAgeMs: number,
): CausalDepthReplay {
  const unknown = (reason: NonNullable<CausalDepthReplay['reason']>): CausalDepthReplay => ({
    status: 'UNKNOWN',
    reason,
  });
  if (
    anchor.bufferLengthBefore !== 0 ||
    anchor.bufferLengthAfter !== anchor.bufferedEvents.length ||
    !Number.isSafeInteger(anchor.lastUpdateId) ||
    ![
      anchor.requestedAtMs,
      anchor.snapshotReceivedAtMs,
      anchor.availableAtMs,
      anchor.exchangeUpperBoundAtAvailableMs,
      clocks.exchangeAsOfMs,
      clocks.receivedAsOfMs,
      maxAgeMs,
    ].every(Number.isFinite) ||
    anchor.snapshotReceivedAtMs < anchor.requestedAtMs ||
    anchor.availableAtMs < anchor.snapshotReceivedAtMs ||
    anchor.availableAtMs > clocks.receivedAsOfMs ||
    anchor.exchangeUpperBoundAtAvailableMs >= (clocks.exchangeLowerBoundMs ?? NaN) ||
    !anchor.bids.length ||
    !anchor.asks.length
  )
    return unknown('REST_DEPTH_SNAPSHOT_INVALID');

  const orderedBuffered = anchor.bufferedEvents
    .filter((event) => event.type === 'depth' && event.symbol === anchor.symbol)
    .slice()
    .sort(
      (a, b) =>
        a.receivedAtMs - b.receivedAtMs ||
        Number(a.payload.U) - Number(b.payload.U) ||
        Number(a.payload.u) - Number(b.payload.u),
    );
  if (
    orderedBuffered.length !== anchor.bufferedEvents.length ||
    orderedBuffered.some(
      (event) =>
        event.receivedAtMs < anchor.requestedAtMs || event.receivedAtMs > anchor.availableAtMs,
    )
  )
    return unknown('REST_DEPTH_SNAPSHOT_BUFFER_UNVERIFIED');

  const bids = new Map(anchor.bids.map((level) => [level.price, level.qty]));
  const asks = new Map(anchor.asks.map((level) => [level.price, level.qty]));
  const knownDepthBounds = {
    bidFloor: Math.min(...bids.keys()),
    askCeiling: Math.max(...asks.keys()),
  };
  let last = anchor.lastUpdateId;
  let observedAtMs = anchor.snapshotReceivedAtMs;
  let appliedBufferedEvents = 0;
  const appliedIdentities = new Map<string, string>();
  const fingerprint = (event: ArchiveEvent): string =>
    JSON.stringify([event.eventTime, event.payload.b, event.payload.a]);
  const apply = (event: ArchiveEvent): boolean => {
    const p = event.payload;
    const U = Number(p.U);
    const u = Number(p.u);
    const pu = Number(p.pu);
    if (
      ![U, u, pu].every(Number.isSafeInteger) ||
      U < 0 ||
      u < U ||
      pu < 0 ||
      !Number.isFinite(event.eventTime) ||
      !Number.isFinite(event.receivedAtMs) ||
      p.symbol !== event.symbol ||
      p.eventTime !== event.eventTime ||
      p.receivedAtMs !== event.receivedAtMs
    )
      return false;
    for (const [raw, book, bound] of [
      [p.b, bids, (price: number) => price >= knownDepthBounds.bidFloor],
      [p.a, asks, (price: number) => price <= knownDepthBounds.askCeiling],
    ] as const) {
      if (!Array.isArray(raw)) return false;
      for (const level of raw) {
        if (!Array.isArray(level) || level.length !== 2) return false;
        const price = Number(level[0]);
        const quantity = Number(level[1]);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity < 0)
          return false;
        if (!bound(price)) continue;
        if (quantity === 0) book.delete(price);
        else book.set(price, quantity);
      }
    }
    return true;
  };
  const rememberApplied = (event: ArchiveEvent): void => {
    appliedIdentities.set(
      `${event.payload.U}:${event.payload.u}:${event.payload.pu}`,
      fingerprint(event),
    );
    last = Number(event.payload.u);
    observedAtMs = event.receivedAtMs;
    appliedBufferedEvents++;
  };
  const firstBuffered = orderedBuffered.filter((event) => Number(event.payload.u) >= last);
  let bridgeFound = false;
  if (firstBuffered.length) {
    const first = firstBuffered[0];
    if (!(Number(first.payload.U) <= last && last <= Number(first.payload.u)))
      return unknown('REST_DEPTH_SNAPSHOT_BRIDGE_INVALID');
    if (!apply(first)) return unknown('DEPTH_EVENT_INVALID');
    rememberApplied(first);
    bridgeFound = true;
    for (const event of firstBuffered.slice(1)) {
      const u = Number(event.payload.u);
      if (u <= last) continue;
      if (Number(event.payload.pu) !== last)
        return unknown('REST_DEPTH_SNAPSHOT_BUFFER_SEQUENCE_GAP');
      if (!apply(event)) return unknown('DEPTH_EVENT_INVALID');
      rememberApplied(event);
    }
  } else {
    const futureBridge = events
      .filter(
        (event) =>
          event.type === 'depth' &&
          event.symbol === anchor.symbol &&
          event.receivedAtMs > anchor.availableAtMs &&
          event.receivedAtMs <= clocks.receivedAsOfMs &&
          event.eventTime <= clocks.exchangeAsOfMs &&
          Number(event.payload.u) >= last,
      )
      .slice()
      .sort(
        (a, b) =>
          a.receivedAtMs - b.receivedAtMs ||
          Number(a.payload.U) - Number(b.payload.U) ||
          Number(a.payload.u) - Number(b.payload.u),
      )[0];
    if (!futureBridge) return unknown('REST_DEPTH_SNAPSHOT_BRIDGE_MISSING');
    if (!(Number(futureBridge.payload.U) <= last && last <= Number(futureBridge.payload.u)))
      return unknown('REST_DEPTH_SNAPSHOT_BRIDGE_INVALID');
    if (!apply(futureBridge)) return unknown('DEPTH_EVENT_INVALID');
    rememberApplied(futureBridge);
    bridgeFound = true;
  }
  if (!bridgeFound) return unknown('REST_DEPTH_SNAPSHOT_BRIDGE_MISSING');

  const availableAtMs = Math.max(
    anchor.availableAtMs,
    ...orderedBuffered.map((event) => event.receivedAtMs),
  );
  const checkpoint: DepthCheckpoint = {
    symbol: anchor.symbol,
    receivedAtMs: observedAtMs,
    availableAtMs,
    lastUpdateId: last,
    bids: [...bids].map(([price, qty]) => ({ price, qty })).sort((a, b) => b.price - a.price),
    asks: [...asks].map(([price, qty]) => ({ price, qty })).sort((a, b) => a.price - b.price),
    knownDepthBounds,
  };
  const futureEvents: ArchiveEvent[] = [];
  for (const event of events) {
    if (
      event.type !== 'depth' ||
      event.symbol !== anchor.symbol ||
      event.receivedAtMs < availableAtMs ||
      event.receivedAtMs > clocks.receivedAsOfMs
    )
      continue;
    const identity = `${event.payload.U}:${event.payload.u}:${event.payload.pu}`;
    const previous = appliedIdentities.get(identity);
    if (previous !== undefined) {
      if (previous !== fingerprint(event)) return unknown('DEPTH_DUPLICATE_CONFLICT');
      continue;
    }
    futureEvents.push(event);
  }
  const result = replayCausalDepth(checkpoint, futureEvents, clocks, maxAgeMs);
  if (result.status !== 'VERIFIED' || !result.book) return result;
  return {
    status: 'VERIFIED',
    book: {
      ...result.book,
      appliedEventCount: result.book.appliedEventCount + appliedBufferedEvents,
      knownDepthBounds,
    },
  };
}

/** Reconstructs from the full REST book used by the producer's snapshot-bridge algorithm. */
export function replayCausalDepthFromRestSnapshot(
  anchor: RestDepthSnapshotAnchor,
  events: readonly ArchiveEvent[],
  clocks: {
    exchangeAsOfMs: number;
    receivedAsOfMs: number;
    exchangeLowerBoundMs: number;
  },
  maxAgeMs: number,
): CausalDepthReplay {
  const unknown = (reason: NonNullable<CausalDepthReplay['reason']>): CausalDepthReplay => ({
    status: 'UNKNOWN',
    reason,
  });
  if (anchor.bufferLengthBefore !== 0 || anchor.bufferLengthAfter !== anchor.bufferedEvents.length)
    return unknown('REST_DEPTH_SNAPSHOT_BUFFER_UNVERIFIED');
  if (
    ![
      anchor.requestedAtMs,
      anchor.snapshotReceivedAtMs,
      anchor.availableAtMs,
      anchor.exchangeUpperBoundAtAvailableMs,
      clocks.exchangeAsOfMs,
      clocks.exchangeLowerBoundMs,
      clocks.receivedAsOfMs,
      maxAgeMs,
    ].every(Number.isFinite) ||
    !Number.isSafeInteger(anchor.lastUpdateId) ||
    anchor.lastUpdateId < 0 ||
    anchor.snapshotReceivedAtMs < anchor.requestedAtMs ||
    anchor.availableAtMs < anchor.snapshotReceivedAtMs ||
    anchor.availableAtMs > clocks.receivedAsOfMs ||
    anchor.exchangeUpperBoundAtAvailableMs >= clocks.exchangeLowerBoundMs ||
    !anchor.bids.length ||
    !anchor.asks.length
  )
    return unknown('REST_DEPTH_SNAPSHOT_INVALID');

  const validLevels = (
    levels: readonly { price: number; qty: number }[],
    descending: boolean,
  ): boolean =>
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
    !validLevels(anchor.bids, true) ||
    !validLevels(anchor.asks, false) ||
    anchor.bids[0].price > anchor.asks[0].price
  )
    return unknown('REST_DEPTH_SNAPSHOT_INVALID');

  const bids = new Map(anchor.bids.map((level) => [level.price, level.qty]));
  const asks = new Map(anchor.asks.map((level) => [level.price, level.qty]));
  const knownDepthBounds: DepthKnowledgeBounds = {
    bidFloor: Math.min(...bids.keys()),
    askCeiling: Math.max(...asks.keys()),
  };
  let last = anchor.lastUpdateId;
  let observedAtMs = anchor.snapshotReceivedAtMs;
  let appliedBootstrapEvents = 0;
  const bootstrapIdentities = new Map<string, string>();
  const eventIdentity = (event: ArchiveEvent): string =>
    `${event.payload.U}:${event.payload.u}:${event.payload.pu}`;
  const eventFingerprint = (event: ArchiveEvent): string =>
    JSON.stringify([event.eventTime, event.payload.b, event.payload.a]);
  const validEvent = (event: ArchiveEvent): boolean => {
    const p = event.payload;
    const U = Number(p.U);
    const u = Number(p.u);
    const pu = Number(p.pu);
    return (
      event.type === 'depth' &&
      event.symbol === anchor.symbol &&
      [U, u, pu, event.eventTime, event.receivedAtMs].every(Number.isFinite) &&
      [U, u, pu].every(Number.isSafeInteger) &&
      U >= 0 &&
      u >= U &&
      pu >= 0 &&
      p.symbol === event.symbol &&
      p.eventTime === event.eventTime &&
      p.receivedAtMs === event.receivedAtMs &&
      Array.isArray(p.b) &&
      Array.isArray(p.a)
    );
  };
  const apply = (event: ArchiveEvent): boolean => {
    if (!validEvent(event) || event.eventTime > clocks.exchangeAsOfMs) return false;
    const p = event.payload;
    for (const [raw, book, inKnownRange] of [
      [p.b, bids, (price: number) => price >= knownDepthBounds.bidFloor],
      [p.a, asks, (price: number) => price <= knownDepthBounds.askCeiling],
    ] as const) {
      for (const level of raw as unknown[]) {
        if (!Array.isArray(level) || level.length !== 2) return false;
        const price = Number(level[0]);
        const qty = Number(level[1]);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 0) return false;
        if (!inKnownRange(price)) continue;
        if (qty === 0) book.delete(price);
        else book.set(price, qty);
      }
    }
    return true;
  };
  const remember = (event: ArchiveEvent): void => {
    bootstrapIdentities.set(eventIdentity(event), eventFingerprint(event));
    last = Number(event.payload.u);
    observedAtMs = event.receivedAtMs;
    appliedBootstrapEvents++;
  };
  const buffered = anchor.bufferedEvents
    .slice()
    .sort(
      (a, b) =>
        a.receivedAtMs - b.receivedAtMs ||
        Number(a.payload.U) - Number(b.payload.U) ||
        Number(a.payload.u) - Number(b.payload.u),
    );
  if (
    buffered.some(
      (event) =>
        !validEvent(event) ||
        event.receivedAtMs < anchor.requestedAtMs ||
        event.receivedAtMs > anchor.availableAtMs,
    )
  )
    return unknown('REST_DEPTH_SNAPSHOT_BUFFER_UNVERIFIED');
  const bridgeBuffer = buffered.filter((event) => Number(event.payload.u) >= last);
  let bridgeFound = false;
  if (bridgeBuffer.length) {
    const first = bridgeBuffer[0];
    if (!(Number(first.payload.U) <= last && last <= Number(first.payload.u)))
      return unknown('REST_DEPTH_SNAPSHOT_BRIDGE_INVALID');
    if (first.eventTime > clocks.exchangeAsOfMs)
      return unknown('REST_DEPTH_SNAPSHOT_AFTER_DECISION_BOUND');
    if (!apply(first)) return unknown('DEPTH_EVENT_INVALID');
    remember(first);
    bridgeFound = true;
    for (const event of bridgeBuffer.slice(1)) {
      const u = Number(event.payload.u);
      if (u <= last) continue;
      if (Number(event.payload.pu) !== last)
        return unknown('REST_DEPTH_SNAPSHOT_BUFFER_SEQUENCE_GAP');
      if (event.eventTime > clocks.exchangeAsOfMs)
        return unknown('REST_DEPTH_SNAPSHOT_AFTER_DECISION_BOUND');
      if (!apply(event)) return unknown('DEPTH_EVENT_INVALID');
      remember(event);
    }
  }

  let availableAtMs = Math.max(
    anchor.availableAtMs,
    ...buffered.map((event) => event.receivedAtMs),
  );
  if (!bridgeFound) {
    const candidate = events
      .filter(
        (event) =>
          validEvent(event) &&
          event.receivedAtMs > availableAtMs &&
          event.receivedAtMs <= clocks.receivedAsOfMs &&
          event.eventTime <= clocks.exchangeAsOfMs &&
          Number(event.payload.u) >= last,
      )
      .slice()
      .sort(
        (a, b) =>
          a.receivedAtMs - b.receivedAtMs ||
          Number(a.payload.U) - Number(b.payload.U) ||
          Number(a.payload.u) - Number(b.payload.u),
      )[0];
    if (!candidate) return unknown('REST_DEPTH_SNAPSHOT_BRIDGE_MISSING');
    if (!(Number(candidate.payload.U) <= last && last <= Number(candidate.payload.u)))
      return unknown('REST_DEPTH_SNAPSHOT_BRIDGE_INVALID');
    if (!apply(candidate)) return unknown('DEPTH_EVENT_INVALID');
    remember(candidate);
    availableAtMs = Math.max(availableAtMs, candidate.receivedAtMs);
    bridgeFound = true;
  }
  if (!bridgeFound) return unknown('REST_DEPTH_SNAPSHOT_BRIDGE_MISSING');

  const conflicts = new Map(bootstrapIdentities);
  const futureEvents: ArchiveEvent[] = [];
  for (const event of events) {
    if (
      event.type !== 'depth' ||
      event.symbol !== anchor.symbol ||
      event.receivedAtMs < availableAtMs ||
      event.receivedAtMs > clocks.receivedAsOfMs
    )
      continue;
    if (!validEvent(event)) return unknown('DEPTH_EVENT_INVALID');
    const identity = eventIdentity(event);
    const fingerprint = eventFingerprint(event);
    const previous = conflicts.get(identity);
    if (previous !== undefined) {
      if (previous !== fingerprint) return unknown('DEPTH_DUPLICATE_CONFLICT');
      continue;
    }
    conflicts.set(identity, fingerprint);
    futureEvents.push(event);
  }
  const checkpoint: DepthCheckpoint = {
    symbol: anchor.symbol,
    receivedAtMs: observedAtMs,
    availableAtMs,
    lastUpdateId: last,
    bids: [...bids].map(([price, qty]) => ({ price, qty })).sort((a, b) => b.price - a.price),
    asks: [...asks].map(([price, qty]) => ({ price, qty })).sort((a, b) => a.price - b.price),
    knownDepthBounds,
  };
  const result = replayCausalDepth(checkpoint, futureEvents, clocks, maxAgeMs);
  if (result.status !== 'VERIFIED' || !result.book) return result;
  return {
    status: 'VERIFIED',
    book: {
      ...result.book,
      appliedEventCount: result.book.appliedEventCount + appliedBootstrapEvents,
    },
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
