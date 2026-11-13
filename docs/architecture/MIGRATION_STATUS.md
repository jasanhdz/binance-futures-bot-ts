# Architecture implementation status

This file is the current checkpoint for the incremental platform separation. Strategy modes and
existing operational configuration are unchanged. Micro is a technical reference; its positive
economic edge and profitability are **not demonstrated**.

## Connected runtime graph

| Capability          | Current connection                                                                                                                                                     | Boundary/status                                                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry evaluation    | `TradingService` registers `MomentumRideStrategy` and `MicroBurstStrategy` with the existing typed `StrategyRouter`s.                                                  | Both call their existing policy functions. Aegis still uses its legacy entry orchestration.                                                                                                                                                                                                         |
| Strategy contract   | Micro, Momentum, and test-only `TEST_PROBE` declare config provenance, data requirements, warmup, entry-state recovery, and position-manager ownership.                | `StrategyContractMarketDataProvisioner` explicitly acquires supported leases from `SharedMarketDataRuntime`; `StrategyRouter.evaluateWithReadiness` gates on that lease snapshot. Only test composition uses the adapter; registration has no resource side effects.                                |
| Evaluation outcome  | `StrategyRouter` reports `INTENT`, `REJECTED`, `WAIT`, or `NOT_EVALUABLE` separately from `decision`.                                                                  | Micro and Momentum classify their existing context/evaluation result explicitly. A contracted `NO_TRADE` without classification is `NOT_EVALUABLE`; an uncontracted legacy `NO_TRADE` remains `REJECTED`. OFF/audit failure is `NOT_EVALUABLE`.                                                     |
| Shared market state | `StrategyRuntimeCoordinator` owns one `SharedMarketDataRuntime`; Micro, Momentum, and other consumers can acquire the same order-book/AggTrade state.                  | Contract composition tests explicitly acquire reference-counted leases and prove one subscription per symbol/interval plus shared book/flow state across consumers. The production coordinator still does not automatically provision arbitrary strategy contracts.                                 |
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

## Contract-driven data composition and readiness (test-only first consumer)

`StrategyContractMarketDataProvisioner.acquire(contract, symbol)` is an explicit composition
operation over one existing `SharedMarketDataRuntime`. It does not run from
`StrategyRouter.register()`. The provisioner owns only the leases it acquires; the underlying
planes still own streams, buffers, health, and reference counts. Consumers must call `warmup()`
explicitly where closed candles are required and must call the returned idempotent `release()`
during teardown. Partial acquisition/warmup failure releases leases already obtained.

The current adapter supports only capabilities whose real state is available from those planes:

- `CLOSED_CANDLES`: supported shared intervals, up to the existing plane's bounded history;
  checks actual `closeTime <= capturedAtMs`, source receive age, optional close age, OHLC
  boundaries, minimum closed count, and continuity when `gapPolicy` is `REJECT`.
- `ORDER_BOOK`: known top depth up to the plane's exposed feature depth, current synchronized
  health and receive age. `REQUIRE_LINKED_UPDATES` additionally requires a same-process applied
  watermark and no recorded book gap; a healthy point alone does not claim interval continuity.
- `AGG_TRADE_FLOW`: the buffer's actual window coverage, observed sample count, capacity/gap
  state, and (when `maximumAgeMs` is declared) applied local-monotonic age from the current
  process generation. No exchange-event clock is compared to a local clock.

Benchmark context and realtime feature schemas have no owned lease/state mapping in this adapter;
acquisition throws an explicit unsupported-capability error. Exact duplicate requirements are
rejected; distinct flow windows share the same per-symbol buffer and distinct candle intervals
share their corresponding per-symbol/interval entries. The non-owning
`MarketDataCapabilityCatalog` and profiles remain a separate snapshot-composition prototype: they
do not acquire/release resources and are not used as a second provisioner.

The lease's `read()` returns a detached immutable snapshot. `assess(snapshot)` only accepts
snapshots issued by that lease and evaluates actual state. Insufficient startup coverage returns
`WAIT`; stale, malformed, gapped, truncated, or generation-incomparable evidence returns
`NOT_EVALUABLE` with reason codes. `StrategyRouter.evaluateWithReadiness()` receives that
readiness object and invokes the context factory with its exact snapshot. For non-READY results
the strategy evaluator is not called. The composition test spies on that evaluator and checks
snapshot object identity in the context it receives.

This is exercised exclusively by `TEST_PROBE` and offline Exchange fakes. `TradingService` and
`StrategyRuntimeCoordinator` do not automatically use the adapter for production entries; Micro,
Momentum, and Aegis retain their current composition/readiness paths.

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

1. Decide whether and how production composition should opt into contract-driven provisioning.
   The explicit adapter and readiness gate are currently proved only with `TEST_PROBE`; migrating
   live/shadow production consumers needs separate equivalence/regression proof and must not
   happen at registration time.
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
- `DOTENV_CONFIG_PATH=/dev/null ./node_modules/.bin/vitest run --config src/testing/OfflineVitest.config.ts --exclude 'data/**' --maxWorkers=1 --no-file-parallelism`: PASS, 247 files / 3,198 tests (432.22 seconds).
- Focal composition/ownership/recovery/execution tests cover shared-stream reference counts, disk-backed HOLD/restart/recovery/close, duplicate-record blocking, and `TEST_PROBE` execution denial without exchange mutation.
- Contract-composition tests cover deferred acquisition, shared/interval-keyed leases, differing flow windows, changed requirements changing readiness, warmup WAIT, stale/gapped/unknown-generation NOT_EVALUABLE, unsupported/duplicate requirements, partial rollback, reconnect re-warmup, and same-snapshot evaluation. All use simulated feeds; they are not market evidence.
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
