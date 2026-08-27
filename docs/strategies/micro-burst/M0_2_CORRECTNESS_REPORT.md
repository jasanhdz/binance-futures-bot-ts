# MICRO_BURST_V1 M0.2 Correctness Report

Branch: `work/micro-burst-rider-v1-20260826`

Starting checkpoint: `b1de154214755ae331b43ba7b82a862b1d3038a2`

Scope: correctness, causality, unit safety, deterministic replay, fail-closed data contracts, and position-lifecycle decision semantics. No tuning, edge research, market-data WebSocket implementation, SHADOW authority, LIVE authority, or exchange mutation was added.

## M0.1 Bugs Corrected

1. BTC decimal returns were compared directly with a bps threshold.
2. S/R candle indices were compared with epoch milliseconds.
3. Closed-candle filtering read `Date.now()` internally and used a frozen module-level clock.
4. Aggregate candle freshness could hide a stale timeframe.
5. BTC observation time used an untyped cast.
6. Structural position selected side without requiring matching momentum direction.
7. Hard invalidation compared ROE with a price-return threshold.
8. Early failure could close immediately merely because profit had not appeared yet.
9. SHORT trailing referenced the wrong price extreme.
10. `TARGET` existed as a reason but had no policy implementation.
11. Break-even could request the same stop movement every cycle.
12. Position-manager `manage()` did not compute the Micro Burst exit decision.
13. The execution-intent factory read `Date.now()` twice and accepted unused `pricePrecision`.
14. `roomToTargetBps` and `riskToInvalidationBps` contained decimal returns despite their names.
15. Reward/risk was calculated but not enforced.
16. Book status could be `HEALTHY` while `anomalyFlag` was true.
17. Provider metadata could not propagate `UNSYNCED`.
18. Basic order-book shape, sorting, finite values, and crossed-book validity were unchecked.
19. OFF position management could still invoke the generic lifecycle and mutate protection. M0.2 now computes decisions without invoking mutation primitives.

## Unit Contract

`decimalReturnToBps()` and `bpsToDecimalReturn()` are the central conversion helpers. Decimal return fields retain names such as `ret3m`; every `*Bps` field stores actual bps. The BTC conflict boundary is inclusive: 29 bps does not conflict, 30 bps and 31 bps do when directions oppose.

## Causal Contract

- `buildMicroBurstContext()` requires explicit `snapshotAtMs`.
- Candle availability is exactly `closeTime <= snapshotAtMs`.
- No production Micro Burst domain code reads `Date.now()`.
- 1m, 3m, and 5m freshness are independent and use latest `closeTime`.
- S/R stores `pivotCandleIndex`, `availableAtCandleIndex`, `pivotAtMs`, and `availableAtMs`.
- `availableAtMs` is the `closeTime` of the final right-confirmation candle and is inclusive.
- Future candles in any timeframe cannot change a historical context or S/R result.
- `DataQualityDiagnostics.levelsAvailableAt` is an epoch-millisecond value.

## BTC And Book Contracts

- `BtcContext.observedAtMs` is required.
- BTC `UNAVAILABLE` or `STALE` invalidates context.
- `OrderBookSnapshot` carries depth, `observedAtMs`, provider status, optional `lastUpdateId`.
- Provider `UNSYNCED` propagates unchanged.
- Empty, crossed, unsorted, non-finite, negative-quantity, stale, and anomalous books fail closed.
- Threshold anomalies canonicalize status to `ANOMALOUS`; `HEALTHY` cannot coexist with `anomalyFlag: true`.
- `imbalanceSlope` remains `null`; no temporal behavior is invented before M1.

## Entry Policy

- Direction alignment is mandatory.
- BTC and book availability are explicit gates.
- Structural target/stop geometry must be valid for side.
- Room and risk are true basis points.
- `rewardRisk` must be finite and at least the experimental `minRewardRisk` default.
- No missing-level or invalid-number fallback is permitted.

## Exit Policy

- Structural invalidation uses the persisted absolute stop price and is leverage-independent.
- Proof-window logic distinguishes no-progress, MFE, and MAE.
- Immediate adverse excursion can close inside the proof window.
- Never-proved failure begins inclusively at `exitProofWindowMs`.
- Destination target is implemented for LONG and SHORT.
- LONG software trailing uses retracement from `peakPrice`.
- SHORT software trailing uses retracement from `troughPrice`.
- Trailing always returns `CLOSE_MARKET`; it never returns `MOVE_STOP`.
- Break-even returns `MOVE_STOP` only if entry improves the current stop and never weakens protection.
- Priority interactions are covered explicitly.

## Position Manager

`MicroBurstPositionManagementContext` supplies side and exit context under the only admitted mode, `OFF`. `manage()` asserts ownership, evaluates domain exit policy, translates it to `PositionManagementResult`, and marks `actionApplied: false`. It does not call the lifecycle or exchange while OFF. The reserved lifecycle policy remains tested as structural-stop-only with all legacy dynamic mechanisms disabled.

## Execution Intent

The factory moved to `MicroBurstExecutionIntentFactory.ts`. Caller-supplied `requestedAt` and `tradeId` make it pure and deterministic. The unused `pricePrecision` argument was removed because exchange rounding belongs to shared execution.

## Correctness vs Experimental Defaults

Correctness invariants include synchronized/fresh required data, closed candles only, causal S/R availability, direction alignment, structural geometry, finite reward/risk, structural price invalidation, deterministic exits, and no authority while OFF.

Experimental defaults include regime avoidance, momentum thresholds, BTC threshold magnitude, S/R parameters, proof duration, excursion thresholds, reward/risk minimum, leverage, and sizing. M0.2 does not validate or tune them.

## Validation

- TypeScript build: pending final validation
- Micro Burst tests: pending final validation
- Full suite: pending final validation
- GitHub Actions: pending push

## M1 Market Data Plane Pending

1. Depth WebSocket ingestion.
2. REST snapshot plus diff synchronization.
3. Binance update-ID continuity, gap detection, and resynchronization.
4. Typed synchronized book provider implementation.
5. Live ticker/mark/reference price at snapshot.
6. BTC live context stream with observed timestamp.
7. `aggTrade` ingestion.
8. Temporal book history and real imbalance slope.
9. Temporal absorption detection.
10. Temporal sweep detection.

No M1 item is implemented in this patch.
