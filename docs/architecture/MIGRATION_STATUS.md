# Architecture implementation status

This file is the current checkpoint for the incremental platform separation. Strategy modes and
existing operational configuration are unchanged. Micro is a technical reference; its positive
economic edge and profitability are **not demonstrated**.

## Connected runtime graph

| Capability          | Current connection                                                                                                                                                     | Boundary/status                                                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry evaluation    | `TradingService` registers `MomentumRideStrategy` and `MicroBurstStrategy` with the existing typed `StrategyRouter`s.                                                  | Both call their existing policy functions. Aegis still uses its legacy entry orchestration.                                                                                                                                                                                                         |
| Strategy contract   | Micro and Momentum declare versioned config source, data requirements, warmup, stateless entry state, and position-manager/recovery owner.                             | Router validates identity/config/manager ownership and exposes the declaration. A contracted `NO_TRADE` without classification fails closed to `NOT_EVALUABLE`; legacy adapters retain the `REJECTED` fallback. Requirements still do not provision feeds/readiness automatically.                  |
| Evaluation outcome  | `StrategyRouter` reports `INTENT`, `REJECTED`, `WAIT`, or `NOT_EVALUABLE` separately from `decision`.                                                                  | Micro and Momentum classify their existing context/evaluation result explicitly. A contracted `NO_TRADE` without classification is `NOT_EVALUABLE`; an uncontracted legacy `NO_TRADE` remains `REJECTED`. OFF/audit failure is `NOT_EVALUABLE`.                                                     |
| Shared market state | `StrategyRuntimeCoordinator` owns one `SharedMarketDataRuntime`; Micro, Momentum, and other consumers can acquire the same order-book/AggTrade state.                  | Deterministic integration tests prove shared state and one subscription per symbol/capability for Micro and `TEST_PROBE`. Consumers acquire existing leases; contract declarations do not yet drive lease acquisition.                                                                              |
| Candle source       | Momentum uses `CandleDataPlane`; Micro BTC context uses `MarketDataCandleProvider`.                                                                                    | Micro's 1m/3m/5m builder still uses the existing raw exchange `getCandles` adapter and one exchange-as-of boundary. It is represented by the existing `MarketDataPort` contract but not replaced with the streaming plane because closure/availability semantics differ.                            |
| Risk/admission      | Existing `SharedEntrySafetyGate`, strategy risk session, `SharedEntryReservation`, symbol/open-position checks and execution preconditions remain in force.            | Paper integration invokes the production `SharedEntryReservation` and verifies its same-symbol busy result. It does not exercise `TradingService`'s exchange-backed occupied-position path; no netting/hedge ownership is added.                                                                    |
| Execution           | `SharedStrategyExecutionService` remains the exchange mutation boundary used by current entry paths.                                                                   | It still contains Micro contextual-policy/sizing validation; `TradingService` still composes much of Aegis/Micro authority. `TEST_PROBE` is explicitly denied here.                                                                                                                                 |
| Position ownership  | `PositionManagerRouter` routes persisted strategy ownership; `StrategyPositionLifecycleCore` and the existing Aegis/Momentum/Micro managers retain lifecycle policy.   | A missing/mismatched manager requires recovery. Paper positions are keyed by strategy identity.                                                                                                                                                                                                     |
| Paper/replay        | `ShadowTradingEngine` is the shared, recoverable paper lifecycle. Micro's runtime evaluator and paired archive replay call the same `MicroBurstStrategy` entry policy. | A separate deterministic integration test writes two owner-keyed paper positions to JSONL, restarts with new journal/engine instances, manages/HOLDs/closes by owner, and fail-closes duplicate records. Its intents and observations are synthetic fixtures, not Micro signals or market evidence. |
| Snapshot catalog    | `MarketDataCapabilityCatalog`, consumer profiles, and `MarketSnapshotProvider` exist and have tests.                                                                   | Not connected to production decision contexts. Their presence does not mean strategies are provisioned from profiles.                                                                                                                                                                               |

## Strategy ownership in this slice

Micro retains its candle and feature interpretation, regime/support-resistance/momentum logic,
BTC conflict policy, entry/exit decisions, strategy config, and persisted exit-engine state. Its
context can carry shared depth/AggTrade state plus the exact per-source causal watermarks.

`TEST_PROBE` is a tiny test-only strategy using the same `EntryStrategy`, `StrategyRouter`,
`PositionManagerRouter`, shared market state, and `ShadowTradingEngine`. It exercises intent,
reject, wait, unavailable context, recovery, ownership and paper exit. There is no operational
configuration for it, and `SharedStrategyExecutionService` rejects the identity even if a test
constructs a frozen-looking one.

The multi-owner paper lifecycle test uses explicit deterministic fixture intents for both
`MICRO_BURST` and `TEST_PROBE`, marked `SYNTHETIC_ONLY_NOT_MARKET_EVIDENCE`. Those fixture
intents are independent of the evaluated Micro decision; no claim is made that Micro emitted an
entry. Recovery opens fresh JSONL journal and engine objects from disk. Duplicate open records
for a canonical owner/symbol key block recovery. The integration test uses the production
`SharedEntryReservation`; the exchange-backed occupied-position check remains outside this
offline paper fixture.

The probe is not a trading proposal. It establishes that data and lifecycle mechanisms can be
reused without importing Micro policy or sharing its state. The current production composition
still has separate routers for distinct context types, as does the existing runtime coordinator.

The pre-separation Micro behavior reference is the existing deterministic suite:
`MicroBurstStrategy.test.ts`, `MicroBurstReactionEntryPolicy.test.ts`,
`MicroBurstTemporalContracts.test.ts`, `MicroBurstGoldenParity.test.ts`, and
`MicroBurstExitPolicy.test.ts`. It includes LONG/SHORT entries, policy rejection/unusable input,
clock boundaries and paper exit parity. The extraction adds registry/data/paper assertions around
those evaluators; it does not update their expected thresholds or policy outcomes.

## Temporal evidence contract

The new WebSocket provenance is process-scoped:

| Stage             | Evidence retained                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receive           | Original exchange event time and local wall receive time remain unchanged. WebSocket hubs stamp raw payloads; depth keeps that stamp through the port, while the shared AggTrade plane stamps on canonical receipt because the legacy adapter narrows its callback. Both use the process sequence, connection generation and local monotonic sample.                                    |
| Apply             | The synchronized book and AggTrade buffer expose their own applied-state version and last applied receive sequence, separately from their latest received sequence. A queued/duplicate/unapplied event is not silently treated as applied state.                                                                                                                                        |
| Context capture   | Micro exact-input evidence includes a local monotonic capture boundary and the depth/AggTrade state-watermark vector consumed by the decision. Decision-time monotonic evidence is recorded separately from context capture.                                                                                                                                                            |
| Persistence       | Raw segments include storage-writer generation, append-queue sequence and append boundary. SQLite book checkpoints include storage generation/sequence plus the depth state watermark. The decision records the storage watermark sampled for its input; replay only uses a checkpoint from that writer generation/sequence whose synchronous commit boundary precedes context capture. |
| Restart/reconnect | Receive sequences are compared only inside one process generation. Socket reconnects carry a new connection generation. SQLite/archive writers have their own generation and sequence. No sequence or monotonic clock is compared across process restarts.                                                                                                                              |

When local-causal evidence is present, replay can use same-generation sequence watermarks to
order equal or regressing local wall timestamps and to avoid consuming events received after the
book state used by a decision. It still preserves original exchange `E/T` values and requires
exchange-time bounds for market-time replay. A local sequence proves what the bot received or
applied; it does not prove the market state at a different exchange instant or an executable
fill. If process generations differ, sequence evidence is not comparable and the affected state
is UNKNOWN.

V7 was produced before these local sequence fields existed. It remains intact and is replayed
under its original timestamp evidence. Its two exchange-clock regressions per symbol and its
UNKNOWN intervals are not reclassified using metadata that was never captured. Full requests,
before/after reports, report hashes and executor provenance are archived at
[`../research/micro-observer-v7/`](../research/micro-observer-v7/README.md); no capture segments
or SQLite are in Git. New-provenance behavior is validated with synthetic feed/storage/replay
fixtures only; this phase did not start a new collection to claim an end-to-end recorded session.

## ML/ONNX boundary

The core strategy contracts now define a versioned feature schema shape (name, order, scalar
type, units, evidence/time availability, missing-value policy and warmup state) and a
model-prediction input with model/schema identity and feature evidence hash. A future Python
training pipeline can export a model and an optional TypeScript/ONNX adapter may supply that
prediction as strategy input. Neither feature materialization, model loading, training,
ONNX Runtime nor inference is implemented; execution and risk remain downstream of strategy
decisions.

## Documents and current gaps

See [`../README.md`](../README.md) for the document inventory, canonical sources, and cleanup
decisions. Remaining seams for the next phase:

1. Make strategy contract requirements drive the existing runtime's subscription/readiness
   composition without creating a second registry or changing data freshness semantics. For
   now, the router only requires explicit evaluation classification from contracted adapters;
   candle closure/freshness parity and runtime readiness remain strategy-specific/manual.
2. Decide whether to expose the existing `MarketDataCapabilityCatalog` to runtime consumers or
   retire it; do not treat it as connected today.
3. Complete a Micro 1m/3m/5m source adapter over a shared capability only after tests demonstrate
   exact OPEN/CLOSED classification, as-of boundary, warmup, order, deduplication, quality,
   BTC-context and numerical parity. Current semantics are preserved behind `MarketDataPort`.
4. Further reduce `TradingService`/`StrategyRuntimeCoordinator` composition and extract the
   Micro-specific branch from shared execution only where current policy and safety checks can
   be kept equivalent.
5. Clarify and test account-wide exposure across coexisting strategies. Existing entry
   reservation/open-position checks remain the conservative boundary; there is not a new
   portfolio netting or cross-strategy margin allocator.
6. Keep the synthetic probe test-only; do not register it in operational YAML or give it live
   authority.

## Verification of this implementation slice

- Current workflow Node runtime: Node 22, matching `better-sqlite3@13.0.3`'s `>=22` engine. Offline Vitest uses `OfflineVitest.config.ts`, one worker, no file parallelism, and a 30-second per-test timeout for SQLite/fsync-heavy serial runs. The Momentum soak remains behind successful build, test, and static read-only audit steps.
- `npx tsc -p tsconfig.json --noEmit`: PASS. A full TypeScript compile to `/tmp/opencode/binance-futures-bot-ts-build-check` also passed without writing into repository `dist/`.
- `DOTENV_CONFIG_PATH=/dev/null ./node_modules/.bin/vitest run --config src/testing/OfflineVitest.config.ts --exclude 'data/**' --maxWorkers=1 --no-file-parallelism`: PASS, 246 files / 3,191 tests (467.85 seconds).
- Focal composition/ownership/recovery/execution tests cover shared-stream reference counts, disk-backed HOLD/restart/recovery/close, duplicate-record blocking, and `TEST_PROBE` execution denial without exchange mutation.
- Directed regression and integration tests cover local equal/regressing clocks, reconnect
  generations, received-vs-applied book versions, deferred append vs persistence watermark,
  archived local-order replay, exchange-clock regression remaining UNKNOWN, Micro policy/paper
  baseline, test-probe owner recovery/exit, and execution denial.
- The pinned `BinanceAdapter.ts` operational-semantics source remains byte-identical; monotonic
  REST instrumentation is in the read-only capture wrapper instead.
- Prettier checks on changed files and `git diff --check`: PASS.
- V7 was only read from the durable capture; no capture or real/private exchange call was run.

No strategy thresholds, sizing, leverage, symbols, LIVE settings, PM2 state or `dist` output
were changed by this separation.
