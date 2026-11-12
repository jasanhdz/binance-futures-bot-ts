# Micro Burst — strategy reference

The runtime identity is `MICRO_BURST` (the current policy version is configured separately).
This strategy is a deterministic technical reference inside the shared platform. Its existing
entry/exit rules and defaults are preserved; no profitability or positive edge is established.
M3 prospective outcome validation is observational/research-only and does not tune policy.

## Authority

- Runtime mode and authority continue to come from the existing configuration/identity checks; this architecture phase does not alter them.
- SHADOW evaluation records decisions and may drive the existing paper engine. It does not submit exchange orders.
- A Micro intent remains subject to shared admission, risk and `SharedStrategyExecutionService`; intent is not authorization.
- The position manager may compute and translate an exit decision, but does not apply lifecycle or exchange mutations.
- The outcome tracker observes post-T0 prices and computes prospective outcomes — it has no exchange mutation authority.

The existence of a guarded LIVE path is not evidence of profitability and was not enabled or
exercised by this work.

## Correctness Invariants

- Price returns are decimal: `0.003 = 0.3% = 30 bps`.
- Variables ending in `Bps` contain true basis points: `30`, not `0.003`.
- BTC conflict uses an inclusive bps boundary after converting `ret3m` from decimal.
- BTC and order book observations require typed epoch-millisecond timestamps and must be fresh.
- Missing, stale, unsynced, anomalous, crossed, malformed, or incorrectly sorted book data fails closed.
- Candles are available only when `closeTime <= snapshotAtMs`.
- Freshness is checked independently for 1m, 3m, and 5m using candle `closeTime`.
- S/R levels retain pivot indices for audit, but causality uses `pivotAtMs` and `availableAtMs` from real candle close times.
- A level is available inclusively when `availableAtMs <= snapshotAtMs`.
- LONG requires near support plus LONG momentum; SHORT requires near resistance plus SHORT momentum.
- Structural stop and destination must exist on the correct side of the reference price.
- Entry requires minimum room and finite minimum reward/risk.
- Hard invalidation uses the persisted structural price, never ROE or leverage conversion.
- LONG trailing retraces from `peakPrice`; SHORT trailing retraces from `troughPrice`.
- Trailing V1 is a deterministic software callback that returns `CLOSE_MARKET`.
- Break-even is the only dynamic `MOVE_STOP` action and cannot repeat or weaken an existing stop.
- Execution intent creation is pure: `requestedAt` and `tradeId` are supplied by the caller.
- Initial structural protection remains an absolute price through exchange tick rounding; it is never converted to ROE.
- No domain import may depend on Aegis, CurrentBrain, E4, ExitEye, MomentumRide, or legacy ProfitGuardian.

## Initial Execution Protection

`createMicroBurstExecutionIntent()` supplies `structuralStopPrice`, `requireStop: true`, `requireTakeProfit: false`, and `closeIfProtectionFails: true`; it deliberately supplies no `stopRoe` or `takeProfitRoe`.

`SharedStrategyExecutionService` now accepts either a negative ROE stop or one positive finite structural price, but denies both together as ambiguous. A structural stop is rounded only by exchange symbol filters and then checked against the confirmed fill: below entry for LONG and above entry for SHORT. Invalid geometry, placement failure, or failure to verify the exact rounded STOP follows the existing emergency-close path.

`destinationPrice` remains owned by `MicroBurstExitPolicy` as a software destination. M0.3 does not create an exchange take-profit order and does not connect the factory to a production execution call site.

## Reference Price

`MicroBurstContext.currentPrice` is the close of the latest closed 1m candle available at `snapshotAtMs`. It is a causal replay reference price, not a live ticker, best bid, or best ask. M1 may introduce a typed `marketPriceAtSnapshot` from a synchronized market-data source.

## Exit Priority

1. `HARD_INVALIDATION`
2. `ANOMALY`
3. `BTC_REVERSAL`
4. Immediate adverse `EARLY_FAILURE`
5. `TARGET`
6. Software callback `TRAILING`
7. One-way `BREAK_EVEN` stop movement
8. Proof-window `EARLY_FAILURE`
9. `MAX_HOLD`
10. `HOLD`

Break-even wins over max hold once when it improves protection. On the next cycle, an entry-or-better stop suppresses repeated break-even and max hold can close.

## Time To Prove

During `exitProofWindowMs`, lack of positive progress alone does not close a position. Structural invalidation, anomaly, BTC reversal, target, and immediate adverse excursion remain active. At the inclusive end of the proof window, a trade that never reached `exitMinProofExcursionBps` returns `EARLY_FAILURE`. A trade that previously proved itself is not categorized as never-proved after a pullback.

## Experimental Parameters

The following are experimental defaults, not validated edge or profitability claims:

- Momentum strength and continuation thresholds.
- Volatile-regime avoidance.
- 30 bps BTC conflict threshold.
- S/R lookback, pivot, clustering, and near-level thresholds.
- Proof-window duration and excursion thresholds.
- Minimum reward/risk.
- 40x/20x leverage tiers and position fractions.

They were not tuned in M0.2.

## Lifecycle Policy

`MICRO_BURST_RESERVED_POLICY` remains:

- `useLegacyProfitGuardian: false`
- `useBreakEven: false`
- `useTrailing: false`
- `requireStopBracket: true`
- `requireTakeProfitBracket: false`
- `closeIfBracketFails: true`
- `allowManualQuantityReconciliation: false`

Dynamic exits belong only to `MicroBurstExitPolicy`; legacy lifecycle logic cannot supply them.

## Platform integration and remaining adapters

`StrategyRuntimeCoordinator` constructs one `SharedMarketDataRuntime` and passes its canonical
`OrderBookDataPlane` and `AggTradeDataPlane` into the integrated `MicroBurstRuntime`. Micro's
`MicroBurstContextBuilder` reads the shared synchronized book and rolling flow when supplied;
reference-counted leases ensure other consumers see the same state and stream. The runtime
retains fallback constructors for isolated tests and other explicit compositions.

Micro's 1m/3m/5m context candles still come through its `MarketDataPort.getCandles` adapter,
classified together against one exchange `snapshotAtMs`. `MarketDataCandleProvider` and
`CandleDataPlane` use separate per-request or streaming/local availability boundaries. A fixture
demonstrates that identical candle bytes can be OPEN in one boundary and CLOSED in the other.
Therefore the adapter remains behind the shared exchange capability until an explicit parity
contract can be proven; no feature, warmup or signal behavior is silently substituted.

Micro also retains a strategy-specific BTC context/polling adapter and reference-price
selection. `MarketSnapshotProvider` and its non-owning capability catalog are implemented but
are not currently the input composition used by this strategy. `TradingService` and
`StrategyRuntimeCoordinator` still contain strategy-specific construction and admission work;
the remaining seams are tracked in `docs/architecture/MIGRATION_STATUS.md`.

## Causal capture, paper and replay

WebSocket events preserve Binance event/transaction timestamps and carry a separate
process-generation, connection-generation, receive sequence and monotonic receive sample.
Book/flow state snapshots carry applied state versions and last-applied receive sequences.
Micro's exact decision input includes those per-source watermarks and the local monotonic
context/decision boundaries. The market archive records writer generation/append sequence and
SQLite checkpoints record a synchronous persistence sequence. None of these counters is
comparable across a process restart.

Paired replay uses the same `MicroBurstStrategy`/entry evaluator as runtime and then supplies a
distinct verified-market execution model. Knowledge reconstructed from the bot's input and a
claim about what an order could execute in the market are separate guarantees. Replay keeps
UNKNOWN whenever local generation, exchange-time bounds, event chain, point book, persistence
boundary or market interval cannot be verified.

V7 predates local sequence and persistence-writer fields. Its original exchange timestamps and
UNKNOWN intervals remain unchanged; see the durable [V7 reports and requests](../../research/micro-observer-v7/README.md).
No new capture was started for this phase.

The pre-extraction behavior oracle is the existing deterministic suite:
`MicroBurstStrategy.test.ts`, `MicroBurstReactionEntryPolicy.test.ts`,
`MicroBurstTemporalContracts.test.ts`, `MicroBurstGoldenParity.test.ts` and
`MicroBurstExitPolicy.test.ts`. It covers LONG/SHORT entry candidates, rejection and unusable
inputs, proof/clock boundaries, and parity between the existing Micro paper lifecycle and the
shared shadow lifecycle. The platform composition test adds a separate deterministic probe; it
does not alter these expected policy results.

## Research evidence (historical, not strategy authority)

Prospective outcome tracking, replay, and data-integrity work remain separate from the
strategy's entry/exit policy. Dated reports keep their original sample, limitations and
negative results; they are not an active tuning plan:

- `M3_1_PROSPECTIVE_CORRECTNESS_AND_ARCHIVE_REPORT.md`
- `M3_2_EVENT_TIME_RUNTIME_PARITY_REPORT.md`
- `M3_2_1_RUNTIME_CORRECTNESS_CLOSURE_REPORT.md`
- `M3_2_6_4_FINAL_PRE_SOAK_EVIDENCE_REPORT.md`
- [Paired replay evidence and V7 limits](../../micro-paired-replay-evidence.md)
- [Durable V7 requests/reports/hashes](../../research/micro-observer-v7/README.md)

The remaining architecture task is to reuse/provision existing data and cycle services without
changing Micro behavior. Threshold tuning, live activation, backtests claiming edge and changes
to leverage/universe are outside that task and are not prerequisites for proving reuse.
