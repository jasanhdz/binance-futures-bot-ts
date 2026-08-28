# Market Data Capability Composition V1

**Phase:** Q  
**Status:** COMPLETE — non-owning capability composition qualified.

This layer makes two facts explicit without changing market-data ownership:

1. which read-only market capabilities have already been provisioned; and
2. which capabilities a consumer intends to observe.

Availability is not dependency. Registration is not startup.

## Non-owning capability catalog

`MarketDataCapabilityCatalog` stores references to already-existing read capabilities.
Per-symbol registrations may expose quote, synchronized order book, and rolling
AggTrade state. Shared registrations may expose candles and benchmark composition.
Symbols are normalized to uppercase for registration and lookup.

Registering, replacing, looking up, or unregistering a capability never:

- starts or stops an order book;
- acquires or releases a data-plane lease;
- creates a WebSocket subscription;
- creates a timer or polling loop;
- performs exchange mutation;
- persists market data.

`registerSymbol` replaces the complete capability set for the normalized symbol.
`unregisterSymbol` removes only the catalog reference; it does not stop the source.
`registerShared` similarly replaces the catalog's shared candle/benchmark references.

`asSnapshotSources()` adapts the catalog to the existing `MarketSnapshotSources`
contract. It returns the exact registered handles and does not create market-data
providers or duplicate state.

## Consumer observation profiles

A `MarketDataConsumerProfile` is declarative. It contains:

- a consumer/profile identifier;
- primary `SnapshotCapabilityRequest` requirements;
- optional benchmark `SnapshotCapabilityRequest` requirements.

Profiles describe evidence a consumer would like captured. They do not contain
entry/exit policy, side, thresholds, risk, position state, PnL, model scores, or
strategy decisions.

Phase Q intentionally does not define official Aegis, Momentum, or Micro Burst
profiles. Strategy-specific observational profiles are introduced only when those
strategies are attached to the Black Box in later phases.

`defineMarketDataConsumerProfile` detaches and deeply freezes the declared request
shape. False/unrequested capabilities are omitted so `NOT_REQUESTED` remains an
intentional, meaningful state.

## Snapshot request composition

`composeMarketSnapshotRequest(profile, symbol, benchmarkDescriptor?)` converts a
profile into a deterministic `MarketSnapshotRequest` without reading market data.
The runtime symbol and benchmark symbol are normalized to uppercase.

No hidden request expansion is allowed. If a profile requests only quote, the
result requests only quote even when book, AggTrade, or candles are registered.

If a profile declares benchmark requirements, the caller must inject the runtime
`BenchmarkDescriptor`. The composition layer is generic and contains no BTC-specific
rules. `PRIMARY_CRYPTO_BENCHMARK -> BTCUSDT` and another descriptor such as
`SECONDARY_CRYPTO_BENCHMARK -> ETHUSDT` use the same code path.

## Failure isolation / Gate Q

A source that exists in the catalog but is not requested must not be read and must
not affect snapshot health. A missing source that *is* requested is passed to the
already-qualified `MarketSnapshotProvider` as unavailable and becomes explicit
`UNAVAILABLE` evidence for that family.

This preserves the distinction:

- `NOT_REQUESTED`: the consumer deliberately did not depend on the capability;
- `UNAVAILABLE`: the consumer requested it but no usable source/evidence existed.

Different consumers can therefore observe the same symbol with different dependency
profiles while sharing the same underlying market reality.

## Phase boundary

Phase Q does not:

- wire profiles into Aegis, Momentum, or Micro Burst;
- change `MarketSnapshotProvider` semantics;
- change neutral feature formulas;
- change OrderBook/AggTrade/Quote/Candle/Benchmark mechanics;
- perform Phase R cleanup;
- run the Phase S soak;
- implement Black Box persistence or decision logging.
