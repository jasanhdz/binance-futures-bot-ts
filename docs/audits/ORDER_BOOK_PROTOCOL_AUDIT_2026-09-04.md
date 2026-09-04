# USD-M Futures Order Book Protocol Audit — 2026-09-04

## Scope

Read-only audit of the shared local order-book implementation used by Micro/Opportunity. No trading authority, PM2 rollout, strategy change, or Binance order mutation was performed.

## External authority

The current Binance USD-M Futures local-order-book procedure requires:

1. subscribe to the Futures depth stream and buffer events;
2. obtain a REST depth snapshot;
3. discard buffered events with `u < snapshot.lastUpdateId`;
4. the first processed event must satisfy `U <= snapshot.lastUpdateId <= u`;
5. after bootstrap, each event must satisfy `event.pu == previousEvent.u`; otherwise rebuild from a new snapshot;
6. quantities are absolute and zero removes a level.

Reference: Binance USD-M Futures developer documentation, "How to manage a local order book correctly", checked 2026-09-04.

## Finding 1 — Bootstrap boundary differs from the Futures specification

Current `SynchronizedOrderBook.syncFromSnapshot()` filters using:

```ts
event.u >= snapshotUpdateId + 1
```

and selects the bridge using:

```ts
first.U <= lastUpdateId + 1 && lastUpdateId + 1 <= first.u
```

The current USD-M Futures specification uses `lastUpdateId`, not `lastUpdateId + 1`.

Classification: **PROTOCOL_DEVIATION / HIGH PRIORITY**.

This does not prove every observed desync is caused by the boundary, because many normal events span both values. It does prove the implementation and its tests do not exactly encode the current Futures contract.

## Finding 2 — Existing bootstrap test cannot distinguish the two rules

The existing test uses snapshot `lastUpdateId=100` with a buffered event `U=100,u=101`. That event satisfies both:

- official rule: `100 <= 100 <= 101`;
- current +1 rule: `100 <= 101 <= 101`.

Therefore the test remains green even if the implementation follows the wrong boundary.

Required regression fixture: include protocol edge cases where official/current selection differs, plus stale/duplicate and `pu` mismatch cases.

Classification: **TEST_GAP / HIGH PRIORITY**.

## Finding 3 — Snapshot coordinator serializes recovery globally

`DepthSnapshotCoordinator` defaults to `maxConcurrent=1` and accounts a 1000-level snapshot as weight 20. With the configured 1200 weight/minute budget, dispatch is effectively spaced at about one 1000-level snapshot per second.

If many of the 11 symbols become unhealthy together, recovery is serialized while diff-depth events continue arriving. This is consistent with a positive-feedback failure mode:

```text
multiple UNSYNCED books
 -> snapshot queue grows
 -> recovery latency grows
 -> diff buffers grow
 -> buffer overflow
 -> more resyncs
 -> more snapshot demand
```

This matches the observed production symptoms (`UNSYNCED`, `STALE`, `diff-depth buffer overflow`) despite no REST/rate-limit failures.

Classification: **RECOVERY_CAPACITY RISK / HIGH PRIORITY**.

## Finding 4 — Requested snapshot depth is ignored

`DepthSnapshotCoordinator.request(symbol, levels)` accepts a depth argument, but its execution path calls the fetcher with `1_000` unconditionally.

Classification: **IMPLEMENTATION BUG / HIGH CONFIDENCE**.

Impact must be measured before changing production depth, but the coordinator should not silently ignore its contract. Snapshot weight accounting should correspond to the actual requested Binance depth tier.

## Finding 5 — Possible redundant resync after successful in-flight recovery

If the diff buffer overflows/desyncs while `syncFromSnapshot()` is already in flight, `invalidate()` sets `resyncRequested=true`. The current in-flight snapshot can subsequently rebuild a healthy book, but the `finally` block can still schedule another resync because the request flag remains set.

This can create unnecessary recovery churn and should be tested explicitly with a deterministic race fixture before modifying production behavior.

Classification: **RACE / RESYNC-STORM RISK / MEDIUM-HIGH CONFIDENCE**.

## Finding 6 — Production endpoint composition is already aligned with current public Futures paths

`MarketDataEndpoints.ts` builds production public streams under `wss://fstream.binance.com/public/...`, which is consistent with the current Binance documentation. No endpoint-path correction is recommended for the runtime based on this audit.

Classification: **OK**.

## Finding 7 — Shared ownership design is sound

`OrderBookDataPlane` owns one synchronized book per symbol with reference counting. The Opportunity collector therefore does not inherently need to create a second order book for the same symbol.

Classification: **OK**.

## Read-only live probe

A dedicated worker was added at:

`./scripts/order-book-protocol-audit.ts`

and a GitHub Actions workflow at:

`./.github/workflows/order-book-protocol-audit.yml`

The probe uses only public USD-M Futures market-data endpoints. It routes the GitHub runner through the existing Tailscale `iphone-15-pro-max` exit node and has no API keys or order paths.

Observed execution:

- TypeScript build: PASS;
- Tailscale connection: PASS;
- iPhone exit-node routing: PASS on the first live probe;
- Binance USD-M public REST access: PASS;
- BTCUSDT/ETHUSDT read-only protocol worker: PASS;
- artifact upload: PASS;
- no order mutation capability: by construction.

A later repeat was intentionally not used as evidence because the iPhone exit node was unavailable before the Binance step; the workflow failed closed.

## Recommended correction order

1. Add discriminating protocol fixtures before changing implementation.
2. Change bootstrap semantics to exactly encode the current USD-M Futures `lastUpdateId` rule.
3. Preserve strict `pu == previous u` validation after the bridge.
4. Fix the coordinator so requested snapshot depth/weight is honored.
5. Build a deterministic 11-symbol recovery-pressure test and measure queue latency/buffer growth before choosing concurrency/depth limits.
6. Test and eliminate redundant resync scheduling after an in-flight snapshot has already restored HEALTHY.
7. Run an isolated 11-symbol read-only market-data soak through the iPhone exit node.
8. Only after a clean soak, roll the market-data fix into LIVE and repeat Opportunity K.

Do **not** solve this first by merely increasing the 500-event buffer or relaxing the 10s stale threshold. Those changes can hide the underlying protocol/recovery issue instead of fixing it.

## Current verdict

The overall snapshot + buffered diff + `pu` continuity architecture is appropriate for USD-M Futures, but the implementation has a real bootstrap-spec deviation, an uncovered test boundary, and a recovery scheduler that can plausibly become the bottleneck during multi-symbol resynchronization. These should be fixed and soaked before Opportunity dataset quality gate K is reopened.
