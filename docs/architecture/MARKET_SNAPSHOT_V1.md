# Market Snapshot V1

**Schema:** `MARKET_SNAPSHOT_V1` (`schemaVersion: 1`)

`MarketSnapshotProvider` assembles a point-in-time, read-only view from the
existing shared market-data capabilities. It is a composition boundary, not a
feed or lifecycle owner.

## Contract

The provider accepts a normalized-symbol request with optional capability
requests for quote, order-book features, AggTrade flow, candles, and an
optional benchmark descriptor. AggTrade may be requested with `true` or with
the explicit canonical window object. Every capability is represented explicitly:

- `NOT_REQUESTED` means the caller did not ask for that family.
- `AVAILABLE` means the requested family passed its existing neutral feature
  health checks.
- `UNAVAILABLE` means the family was requested but its source, quality, or
  causal boundary was not usable. The error is local to that family.

The aggregate snapshot health is `COMPLETE` when every requested family is
available, `PARTIAL` when at least one requested family is available, and
`UNAVAILABLE` when no requested family is available or no family was requested.
An unavailable family never invalidates other valid families.

## Timestamp Domains

Every capability carries `sourceTimestampMs` and
`sourceTimestampDomain`:

| Family     | Domain          | Meaning                                                                                    |
| ---------- | --------------- | ------------------------------------------------------------------------------------------ |
| quote      | `LOCAL_CAPTURE` | local receive time of the synchronized book observation                                    |
| order book | `LOCAL_CAPTURE` | local observation time of the canonical book state                                         |
| candles    | `LOCAL_CAPTURE` | local REST response observation time; exchange snapshot time remains in the candle feature |
| AggTrade   | `EVENT_TIME`    | rolling event-time watermark; not a local capture timestamp                                |

The provider records `captureStartedAtMs` and `capturedAtMs` from an injected
clock. A local source timestamp later than `capturedAtMs` is rejected as
`SOURCE_OBSERVED_AFTER_CAPTURE_BOUNDARY`. AggTrade event watermarks are not
compared with the local capture clock.

## Determinism And Immutability

The provider reuses the Phase O calculators in
`SharedNeutralMarketFeatures.ts`; it does not duplicate feature formulas or
continuity logic. AggTrade uses the requested event-time window directly from
the existing rolling-state reader. V1 supports exactly one flow window,
`300_000 ms`, when flow is requested; other requested windows are rejected as
unavailable rather than creating another flow definition.

`snapshotId` is the SHA-256 digest of a canonical, recursively key-sorted
serialization of the snapshot contents excluding the ID itself. It includes
capture boundaries, request/provenance, capability values, health, and source
timestamps. The returned snapshot and nested data are detached and deeply
frozen.

## Ownership Boundary

Snapshot capture only invokes read methods on supplied ports. It does not:

- start or stop an order-book or AggTrade data plane;
- acquire or release a lease;
- create subscriptions, polling loops, buffers, or persistence;
- mutate an exchange or strategy state;
- evaluate Micro Burst, Aegis, execution, risk, or decision policy.

Benchmark composition reuses `BenchmarkMarketDataPort`. Benchmark AggTrade is
reported unavailable unless a future contract explicitly supplies that shared
capability; this V1 provider does not create one.
