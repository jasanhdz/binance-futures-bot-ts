# MICRO_BURST_V1

MICRO_BURST_V1 is a deterministic tactical strategy scaffold. M3 implements prospective shadow outcome validation — tracking what happens after each `WOULD_ENTER` signal in real-time, without executing any trades.

## Authority

- `MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED = true` — can evaluate and log decisions.
- `MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = false` — cannot execute.
- Shadow evaluation produces `WOULD_ENTER` telemetry and persists unique signals to JSONL, but never calls `SharedStrategyExecutionService.execute()`.
- The position manager may compute and translate an exit decision, but does not apply lifecycle or exchange mutations.
- The outcome tracker observes post-T0 prices and computes prospective outcomes — it has no exchange mutation authority.

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

## M1 Market Data Plane (Implemented)

- Depth WebSocket ingestion and Binance Futures synchronization algorithm.
- REST snapshot + diff synchronization with update-ID gap detection and resync.
- Typed `OrderBookSnapshotProvider` with `HEALTHY|UNAVAILABLE|STALE|UNSYNCED|ANOMALOUS` health.
- Temporal book history with real `imbalanceSlope`, absorption, and sweep detection.
- Live BTC context stream with 1m/3m/5m decimal returns and acceleration.
- `marketPriceAtSnapshot` (mark price / midpoint) for runtime live reference price.
- `aggTrade` bounded rolling history for taker flow.
- `MicroBurstShadowEvaluator` with structured telemetry and duplicate signal suppression.
- `MicroBurstConfigLoader` for YAML/environment configuration.

## M2 Operational Shadow (Implemented)

`MicroBurstRuntime` wires the shadow evaluation into the live bot runtime with real market data, continuous evaluation, and structured signal journaling. The strategy cannot open, close, or modify any exchange position.

**Signal flow:**

```
TradingService.start()
  └─ MicroBurstRuntime.start()
       ├─ BtcMicroContextProvider (shared BTC 1m stream)
       ├─ SynchronizedOrderBook per symbol (depth diff + snapshot sync)
       ├─ MicroBurstAggTradeBuffer per symbol (aggTrade streaming, taker flow)
       ├─ MicroBurstReferencePriceProvider per symbol (mark price / midpoint)
       ├─ MicroBurstShadowEvaluator
       │    └─ MicroBurstContextBuilder (candles + book + BTC + ref price + aggTrade)
       │         └─ StrategyRouter.evaluate('MICRO_BURST_V1')
       ├─ Evaluation loop (configurable interval, default 5s, per-symbol in-flight guard)
       ├─ Health reporting (60s interval, MICRO_BURST_SHADOW_HEALTH log)
       └─ MicroBurstSignalJournal (append-only JSONL persistence)
```

**What M2 enables:**

- Real depth WebSocket per symbol via `SynchronizedOrderBook` with gap detection and resync.
- Real BTC context via `BtcMicroContextProvider` (1m REST polling, 1m/3m/5m returns, acceleration).
- Real aggTrade streaming per symbol via `MicroBurstAggTradeBuffer` (bounded rolling history, taker flow computation).
- Real reference price via `MicroBurstReferencePriceProvider` (mark price polling, midpoint fallback, source tracking).
- AggTrade taker flow integrated into `MicroBurstContext` and diagnostics.
- `MicroBurstSignalJournal`: append-only JSONL for unique `ENTRY_INTENT` signals with rotation at 10,000 entries.
- Evaluation loop with configurable interval and per-symbol in-flight guard preventing overlapping evaluations.
- Health reporting every 60s with `MICRO_BURST_SHADOW_HEALTH` structured log.
- Config from YAML `micro_burst` section or environment variables.

**What M2 explicitly does NOT enable:**

- No `SharedStrategyExecutionService.execute()` is called.
- No `marketOpen` calls.
- No `placeStopClose` calls.
- No `placeTpClose` calls.
- No `closeSideMarketSafe` calls.
- No exchange mutation of any kind.
- `liveExecution: false` is hardcoded in all evaluation results.
- `MICRO_BURST_V1_LIVE_NOT_AUTHORIZED` thrown if LIVE mode attempted.

## M3 Prospective Shadow Outcome Validation (Implemented)

M3 tracks what happens after each `WOULD_ENTER` signal by observing post-T0 prices and computing prospective outcomes.

**Architecture:**

```
Entry Plane (unchanged):
  MicroBurstRuntime → ShadowEvaluator → StrategyRouter → ENTRY_INTENT

Outcome Plane (new):
  MicroBurstOutcomeTracker
    ├─ freezeSignalSnapshot() — immutable T0 snapshot
    ├─ processTradeEvent() — observe post-T0 prices
    ├─ computeHorizonOutcome() — MFE/MAE/barrier per horizon
    ├─ simulateDynamicExit() — reuses MicroBurstExitPolicy
    └─ MicroBurstOutcomeJournal — JSONL append-only
```

**Key features:**
- 5 outcome horizons: 15s, 30s, 60s, 120s, 300s
- 3 entry price models: SIGNAL_PRICE, NEXT_TRADE, CONSERVATIVE_SLIPPAGE
- 5 cost scenarios: cost_0 through cost_30
- First-touch detection using trade-level temporal ordering
- Dynamic exit counterfactual simulation (reuses exit policy)
- Independent episode tracking
- Restart recovery from journal
- Memory-bounded pending outcomes (max 500)
- Anti-lookahead guarantees (verified by tests)
- Negative controls (shuffled timestamps, random side)

**What M3 explicitly does NOT enable:**

- No tuning during collection
- No live execution
- No exchange mutation of any kind
- No economic edge declaration without sufficient N
- No LIVE_READY declaration during M3

## M4 Scope Pending

- Tune S/R detection parameters for real market conditions.
- Tune momentum thresholds and leverage tiers.
- Validate temporal absorption/sweep thresholds.
- Backtest signal quality with shadow journal data.
- Evaluate economic edge with accumulated prospective data.
