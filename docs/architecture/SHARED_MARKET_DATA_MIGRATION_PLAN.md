# Shared Market Data Migration Plan — A to Z

**Status:** EXECUTION ROADMAP / SOURCE OF TRUTH  
**Design authority:** `SHARED_MARKET_DATA_ARCHITECTURE_V1.md`  
**Reviewed baseline:** `f39215fd4a2c89d3cbbf32c84ea204486fc65e21`  
**Principle:** migrate reusable market facts above strategies without changing strategy meaning or LIVE behavior.

## 1. Program objective

Build a strategy-independent, read-only market-data plane that exposes order book, AggTrades, candles, quotes, benchmark data, neutral shared features, and causal snapshots to any strategy or research consumer that opts in.

Micro Burst remains the behavioral reference for the already-qualified order-book and AggTrade mechanics during extraction. Aegis and Momentum remain unchanged decision systems until separate evidence justifies an experiment.

This roadmap intentionally uses small gated phases. No phase authorizes the next phase automatically. Each implementation wave must end with tests, exact-SHA CI, a diff audit, and an explicit stop/go decision.

## 2. Global invariants for every phase

Every phase MUST preserve:

- Aegis LIVE entry/exit behavior.
- Momentum LIVE entry/exit behavior.
- Micro Burst entry/exit policy and frozen thresholds.
- Micro Burst `SHADOW`, `liveExecution=false`, read-only exchange boundary.
- Generic `ShadowTradingEngine` semantics.
- no new Binance mutation capability.
- no strategy tuning based on small paper samples.
- no destructive evidence-path migration.
- event/exchange time distinct from local receive time.
- fail-closed market-data quality.
- current qualified order-book and AggTrade continuity semantics.

If a phase cannot satisfy these invariants, it is BLOCKED rather than hacked around.

## 3. A–Z roadmap

### A — Audit the real current data graph

Goal: map actual runtime construction and consumers before moving code.

Audit at least:

- `MarketDataPort`
- `MarketDataHub`
- `MarketDataEndpoints`
- `WebSocketManager` / Binance adapter read-only market methods
- `MicroBurstMarketData`
- `SynchronizedOrderBook`
- `MicroBurstAggTradeBuffer`
- `MicroBurstMarketDataTypes`
- `MicroBurstContextBuilder`
- `MicroBurstReferencePrice`
- `BtcMicroContextProvider`
- `MicroBurstBookPressureAnalyzer`
- Micro Burst runtime wiring
- other consumers of partial depth / AggTrades, especially `LiquidityVoidDetector` and `TradingService`

Deliverable: update `SHARED_MARKET_DATA_CLASSIFICATION.md` if the implementation differs from the documented baseline.

Gate A: no code behavior change.

### B — Freeze behavioral contracts and golden fixtures

Before extraction, add/confirm characterization tests for current:

- order-book synchronization and bridge behavior;
- stale/unsynced/anomalous states;
- reconnect/resync behavior;
- AggTrade normal, gap, duplicate, out-of-order, missing identity, reconnect, persisted gap, expiry;
- Micro Burst context outputs that consume these states.

Use current qualified implementations as the oracle.

Gate B: tests demonstrate what must not change.

### C — Introduce granular shared market-data contracts

Create the smallest read-only strategy-neutral contracts needed for extraction. Prefer granular capabilities over widening the already broad `MarketDataPort` indefinitely.

Conceptual contracts:

- normalized market event/time types;
- `OrderBookPort`;
- `AggTradePort`;
- later `QuotePort`, `CandlePort`, `BenchmarkMarketDataPort`.

Do not migrate consumers yet. Compatibility aliases are acceptable.

Gate C: shared contracts compile with no concrete strategy imports and no mutation authority.

### D — Standardize clocks and quality vocabulary

Create reusable neutral types for:

- exchange/event time;
- local receive time;
- source observed time;
- health / quality states.

Do not silently reinterpret existing persisted schemas.

Gate D: tests reject future/invalid causal state and preserve both clocks.

### E — Extract normalized depth event/snapshot types

Move or alias the strategy-neutral depth diff/snapshot envelopes currently split between `MarketDataPort`, `MicroBurstMarketData`, and `MicroBurstMarketDataTypes` into shared market-data contracts.

Micro Burst compatibility types may temporarily re-export shared definitions.

Gate E: no wire-format semantic change.

### F — Extract synchronized order-book core

Create a generic synchronized order-book implementation/provider outside the Micro Burst strategy namespace.

It owns mechanics only:

- snapshot/diff synchronization;
- update-ID chain;
- quality/freshness;
- gap/resync;
- bounded canonical levels;
- source timestamps.

Do not move `MicroBurstBookPressureAnalyzer` into shared core.

Gate F: generic implementation passes the frozen order-book characterization suite.

### G — Add Micro Burst order-book compatibility adapter

Make Micro Burst consume the generic order-book implementation through a compatibility adapter or shared interface without changing Micro Burst policy or output types unnecessarily.

Keep old class as a test/reference alias until parity is proven.

Gate G: old-vs-new golden parity for book snapshots, health transitions, and Micro Burst context.

### H — Qualify order-book runtime parity

Run full tests, exact-SHA CI, architecture import audit, and a bounded SHADOW-only runtime observation if deployment is separately authorized.

Success criteria:

- healthy book counts equivalent;
- no new resync storm;
- no new invalid-context pattern caused by extraction;
- Micro Burst mutations remain zero;
- Aegis/Momentum unchanged.

Stop after H for review before AggTrade extraction if any uncertainty remains.

### I — Extract normalized AggTrade event types

Move/alias strategy-neutral AggTrade event parsing and identity fields into shared market-data contracts.

Do not change the currently qualified meaning of aggregate IDs, first/last trade IDs, event time, trade time, or receive time.

Gate I: parser parity.

### J — Extract shared AggTrade rolling state

Create generic AggTrade buffer/state outside the Micro Burst namespace.

Preserve:

- event-time retention;
- out-of-order insertion;
- pending gaps;
- persisted gap check;
- missing identity;
- capacity truncation;
- window coverage;
- reconnect continuity invalidation.

Neutral taker-flow summaries may remain with the shared buffer if definitions are strategy-independent.

Gate J: all existing AggTrade qualification cases pass against generic implementation.

### K — Migrate Micro Burst AggTrade consumption with golden parity

Micro Burst consumes the shared provider/buffer. Strategy interpretation remains unchanged.

Gate K:

- no premature readiness;
- same context validity;
- same taker-flow values;
- same gap behavior;
- existing golden Micro Burst lifecycle remains green.

### L — Normalize quote capability

Introduce/clarify neutral quote semantics:

- bid;
- ask;
- midpoint;
- receive timestamp;
- health.

Do not conflate mark price with executable quote.

Gate L: shadow executable pricing remains unchanged.

### M — Normalize candle capability

Move toward a neutral candle capability with explicit timeframe, closed/open status, freshness, and gaps.

Do not force all strategies onto a new candle storage implementation in one step. Wrap existing APIs first.

Gate M: Aegis, Momentum, and Micro Burst candle inputs remain equivalent.

### N — Normalize benchmark market data

Expose BTC/benchmark raw market facts independently from Micro Burst.

Keep `btcConflict`, thresholding, or directional interpretation inside each strategy.

Gate N: Micro Burst BTC context parity; no Aegis/Momentum decision dependency added.

### O — Define shared neutral features V1

Only after raw state is shared, define a small versioned feature set whose meaning is strategy-independent.

Initial candidates:

- spread bps;
- top-N signed imbalance;
- depth totals;
- raw taker buy/sell/net volume;
- trade count/rate;
- simple returns;
- quality/age/coverage diagnostics.

Do not promote Micro Burst book-pressure score, burst score, or `room` into shared features.

Gate O: every shared feature has formula, unit, causal source, version, and deterministic tests.

### P — Build `MarketSnapshotProvider` V1

Build a read-only assembler over granular capabilities.

Requirements:

- request only needed capabilities;
- no mandatory global God object;
- per-source health and timestamps;
- deterministic `snapshotId` or durable identity strategy;
- captured receive-time boundary;
- no future data;
- immutable returned snapshot.

Gate P: snapshot anti-lookahead tests pass.

### Q — Add capability registration/composition

Composition should make requirements explicit by consumer.

Micro Burst may require book/AggTrades; Aegis/Momentum must not become dependent on them merely because the shared plane exists.

Gate Q: optional feed failure cannot stop an unrelated strategy that does not require it.

### R — Remove Micro Burst ownership of generic market mechanics

After parity and runtime qualification, strategy-named generic implementations may become compatibility wrappers/re-exports or move to legacy/reference status.

Do not delete them until:

- no production import depends on them;
- golden/reference tests have a deliberate replacement;
- historical tooling remains readable.

Gate R: dependency audit shows market mechanics no longer owned by Micro Burst.

### S — Shared market-data soak qualification

Before using the plane for black-box evidence, perform a bounded read-only soak that measures:

- book health;
- AggTrade continuity;
- candles/quotes;
- snapshot success/failure by capability;
- latency/CPU/memory;
- archive/write pressure where applicable;
- mutation audit = 0.

No strategy thresholds are tuned from this soak.

Gate S: shared data plane operationally trustworthy.

### T — Define generic Strategy Decision Black Box contracts

Implement only after `STRATEGY_DECISION_BLACKBOX_V2.md` requirements are satisfied.

Separate:

- `MarketSnapshot`;
- `StrategyDecisionSnapshot`;
- later `Outcome`.

Black-box failures must not change a strategy decision unless future governance explicitly chooses evidence-required fail-closed collection for an official cohort.

Gate T: observational one-way dependency enforced.

### U — Attach Micro Burst to black box first

Micro Burst becomes the first consumer because its market-data semantics are already strongest and it runs SHADOW.

Capture pre-outcome decision-time evidence without changing decision behavior.

Gate U: deterministic snapshot/decision linkage and no leakage.

### V — Attach Aegis observationally

Record shared market snapshots around Aegis decision points, including order-book/AggTrade information if available, but do not expose those observations to Aegis decision logic.

Gate V: Aegis decisions are identical with black-box logging on/off.

### W — Attach Momentum observationally

Same rule as Aegis: observe without changing strategy inputs or decisions.

Gate W: Momentum decisions are identical with black-box logging on/off.

### X — Build offline outcome resolver and learning datasets

Outside the critical trading runtime, join decision-time evidence with future outcomes.

Requirements:

- no future feature leakage;
- fixed preregistered horizons;
- managed-paper outcomes kept distinct from neutral fixed-horizon outcomes;
- independent episode IDs;
- provenance by SHA/config/schema/strategy version;
- all candidates retained where outcome can be scored, not only winners or executed trades.

Gate X: dataset audit passes before any modeling.

### Y — Explore models offline only

Potential targets include:

- `P(net14 > 0)`;
- `P(net20 > 0)`;
- expected MFE;
- expected MAE;
- expected gross/net bps;
- residual move after detection.

Models are research artifacts only. No runtime gate is introduced in this phase.

Gate Y: out-of-sample/temporal validation and negative controls.

### Z — Promotion governance for any future learned signal

Only if a feature/model demonstrates stable economic improvement after realistic costs:

1. freeze the candidate;
2. preregister baseline vs treatment;
3. validate prospectively in SHADOW;
4. require sufficient independent episodes;
5. test by side/symbol/regime/stability;
6. run negative controls;
7. only then consider a tiny explicitly authorized LIVE canary.

No result in this architecture program itself grants LIVE authority.

## 4. Recommended implementation waves

The A–Z roadmap is deliberately larger than one Codex task. Execute it in waves.

### Wave 1 — shared order book foundation

Scope: A through H.

Outcome: generic order-book core + Micro Burst parity, no behavior change, no deployment unless separately authorized after review.

### Wave 2 — shared AggTrade foundation

Scope: I through K.

Outcome: generic AggTrade core + Micro Burst continuity parity.

### Wave 3 — remaining shared facts

Scope: L through N.

Outcome: quote/candle/benchmark capabilities without strategy dependency expansion.

### Wave 4 — neutral feature and snapshot layer

Scope: O through S.

Outcome: trustworthy causal `MarketSnapshotProvider` and operational soak.

### Wave 5 — black-box observation

Scope: T through W.

Outcome: all strategies can produce decision evidence tied to the same shared market reality, without changing decisions.

### Wave 6 — offline learning

Scope: X through Z.

Outcome: governed datasets/experiments; no automatic production promotion.

## 5. Wave 1 exact acceptance criteria

Wave 1 is the first coding task after this documentation commit.

Required:

1. Audit current branch after pulling documentation.
2. No change to `MarketDataHub` topology unless a correctness issue is demonstrated.
3. Introduce neutral order-book contracts/types without breaking existing imports.
4. Extract the synchronized book mechanics from `src/domain/strategies/micro-burst/SynchronizedOrderBook.ts` into a shared namespace chosen consistently with repository architecture.
5. Keep `MicroBurstBookPressureAnalyzer` strategy-specific.
6. Keep Micro Burst thresholds and context semantics unchanged.
7. Add compatibility adapter/re-export if needed.
8. Add parity fixtures/tests for all qualified book states and transitions.
9. Add architecture test: shared market-data core cannot import concrete strategies or mutation ports.
10. Run full tests/build/audits/diff-check.
11. Commit/push and verify exact-SHA CI.
12. Do not deploy automatically.

Wave 1 PASS verdict:

`SHARED_MARKET_DATA_WAVE1_ORDER_BOOK_EXTRACTION_VERIFIED`

If exact behavior cannot be preserved:

`SHARED_MARKET_DATA_WAVE1_BLOCKED`

## 6. Wave 2 exact acceptance criteria

Wave 2 must not begin automatically in the same task unless explicitly authorized after Wave 1 review.

When authorized, it must:

- extract normalized AggTrade types/parsing;
- extract rolling continuity/state;
- preserve all qualification cases;
- migrate Micro Burst through compatibility;
- keep strategy-specific flow interpretation inside Micro Burst;
- pass full exact-SHA CI;
- not deploy automatically.

PASS verdict:

`SHARED_MARKET_DATA_WAVE2_AGGTRADE_EXTRACTION_VERIFIED`

## 7. Required diff classification for every wave

Every executable change must be classified as one of:

- `SHARED_MARKET_DATA_CONTRACT`
- `SHARED_ORDER_BOOK_EXTRACTION`
- `SHARED_AGGTRADE_EXTRACTION`
- `SHARED_QUOTE_CANDLE_BENCHMARK`
- `SHARED_NEUTRAL_FEATURE`
- `MARKET_SNAPSHOT`
- `MICRO_BURST_COMPATIBILITY`
- `BLACKBOX_OBSERVABILITY`
- `TEST_ONLY`
- `UNRELATED`

`UNRELATED = 0`.

## 8. Required regression statement

Every phase report must state explicitly:

```text
AEGIS LIVE ENTRY CHANGED: NO
AEGIS LIVE EXIT CHANGED: NO
MOMENTUM LIVE ENTRY CHANGED: NO
MOMENTUM LIVE EXIT CHANGED: NO
MICRO BURST ENTRY POLICY CHANGED: NO
MICRO BURST EXIT POLICY CHANGED: NO
MICRO BURST SHADOW AUTHORITY CHANGED: NO
LIVE RISK CHANGED: NO
LIVE SIZING CHANGED: NO
LIVE OWNERSHIP CHANGED: NO
LIVE BRACKETS CHANGED: NO
BINANCE MUTATION AUTHORITY CHANGED: NO
```

If any answer is YES, the phase is out of scope and must stop for review.

## 9. Validation standard

Unless a narrower phase explicitly adds more checks, every implementation wave runs:

```bash
npm ci
npm audit
npm audit --omit=dev
npm run build
npx vitest run
git diff --check
```

Also run targeted market-data, Micro Burst, architecture, Aegis, Momentum, and restoration tests.

After commit/push, CI must be verified on the exact final SHA; an older green workflow is not sufficient.

## 10. Production policy during architecture migration

Default is **NO DEPLOYMENT** from implementation tasks.

A later deployment prompt may authorize a controlled SHADOW/read-only rollout only after:

- exact-SHA CI success;
- no P0/P1 correctness blocker;
- no strategy policy change;
- production preflight is safe;
- active real bot-owned position/order state permits a restart;
- manual orders are never touched.

## 11. Documentation update policy

When reality differs from this plan, do not silently code around it. Update the classification and, if architecture changes materially, update this source-of-truth document in the same reviewed change.

The migration plan is intended to prevent architectural drift, not to force a design contradicted by evidence from the repository.
