# MICRO_BURST_V1 — M0.1 Hardening Report

Branch: `work/micro-burst-rider-v1-20260826`
Date: 2026-08-27
Status: COMPLETED — All 24 items addressed. Build PASS. 808/808 tests PASS.

## Summary

M0.1 hardening fixes unit inconsistencies, removes silent fallbacks, adds causal contracts for S/R levels, enforces fail-closed semantics on data quality, connects the exit policy to the position manager, and creates an execution intent factory to preserve risk information through the execution pipeline.

No live/shadow authority is activated. No Aegis/Momentum behavior is modified.

## Changes by category

### 1. Unit conventions (item 1)

- Price returns: decimal (0.001 = 0.1% = 10 bps).
- ROE: decimal (0.10 = 10%).
- BPS: 10 = 0.1%.
- All thresholds expressed consistently.

### 2. Book data status (item 2)

- `BookDataStatus` enum: HEALTHY | UNAVAILABLE | STALE | UNSYNCED | ANOMALOUS.
- `BookPressureSignal.status` carries the status.
- `isBookHealthy()` returns false when status != HEALTHY.

### 3. Static vs temporal book signals (item 3)

- Renamed `absorptionDetected` → `staticBidConcentration` (top-level qty concentration, not temporal absorption).
- Renamed `sweepDetected` → `staticAskConcentration` (depth discontinuity, not temporal sweep).
- `imbalanceSlope` is `number | null` — null when only single snapshot available (no temporal data).

### 4. S/R causal availability (item 4)

- `SupportResistanceLevel.availableAtCandleIndex` — the candle index where right-confirmation bars completed.
- Levels are only available after their `availableAtCandleIndex`.
- `DataQualityDiagnostics.levelsAvailableAt` tracks the latest available level timestamp.

### 5. Config governance (items 5-8)

- `nearLevelThresholdBps` (was hardcoded 50) — now config-driven.
- `momentumSlopePeriod` (was hardcoded `slice(-5)`) — now config-driven.
- `bookMinImbalance` (was hardcoded 0.5/0.7) — now config-driven.
- `srPivotLeftBars`/`srPivotRightBars` separated from `srLookbackBars`.

### 6. Context validity (items 9-10)

- `DataQualityDiagnostics` with `contextValid`, `invalidReasons[]`.
- Fail-closed: insufficient candles, stale candles (>120s), stale book (>30s), unhealthy book → context invalid.
- Entry policy rejects invalid context with `CONTEXT_INVALID` reason.

### 7. Closed candle filtering (item 11)

- `filterClosedCandles()` filters out partial candles based on interval duration.
- Only candles older than their interval are used for analysis.

### 8. Entry policy hardening (items 12-14)

- No fallback stop/target: if structural level is missing, returns `MISSING_STRUCTURAL_LEVEL`.
- Room gate: `roomToTargetBps >= minRoomBps` enforced.
- Risk gate: `riskToInvalidationBps` computed and returned.
- Leverage/positionFraction/leverageTier carried into `StrategyEvaluationResult.diagnostics`.

### 9. Exit policy integration (items 15-17)

- Price-based trailing (not ROE-based): uses `peakPrice`/`currentPrice` drawdown.
- Break-even uses price comparison (not excursion): moves stop to entry when price is still favorable.
- Priority order: HARD_INVALIDATION → ANOMALY → BTC_REVERSAL → EARLY_FAILURE → TRAILING → BREAK_EVEN → MAX_HOLD → HOLD.
- `MicroBurstExitContext` includes `currentPrice`, `entryPrice`, `peakPrice`, `troughPrice`.

### 10. Exit policy connected to position manager (item 18)

- `MicroBurstPositionManager.evaluateExit()` calls `evaluateMicroBurstExit()`.
- Configurable via constructor.

### 11. Execution intent factory (item 19)

- `createMicroBurstExecutionIntent()` converts approved entry to `StrategyExecutionIntent`.
- Preserves: leverage, positionFraction, structuralStopPrice, destinationPrice.
- Sets protection policy: `requireStop: true`, `closeIfProtectionFails: true`.

### 12. Momentum analyzer (item 20)

- `momentumSlopePeriod` from config used for slope regression window.
- Empty candles handled (returns NEUTRAL with zeroed fields).

### 13. Book pressure analyzer (item 21)

- `bookMinImbalance` from config used for anomaly detection.
- Fail-closed: absent depth → anomalyFlag=true, status=UNAVAILABLE.

### 14. S/R detector (item 22)

- `srPivotLeftBars`/`srPivotRightBars` configurable independently.
- `nearLevelThresholdBps` from config for structural position classification.

### 15. Mandatory tests (item 23)

- 44 tests across 7 test files, all passing.
- Coverage: types, entry policy, exit policy, S/R, momentum, leverage, strategy, position manager.

### 16. Documentation (item 24)

- This report created.
- MIGRATION_STATUS.md updated.
- README.md updated.

## Files modified

| File                                  | Change                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `MicroBurstTypes.ts`                  | Complete rewrite: unit conventions, BookStatus, causal S/R, exit context, data quality, execution intent factory |
| `MicroBurstSupportResistance.ts`      | Causal `availableAtCandleIndex`, config-governed pivot parameters                                                |
| `MicroBurstMomentumAnalyzer.ts`       | Config-governed slope period, empty candle guard                                                                 |
| `MicroBurstBookPressureAnalyzer.ts`   | Fail-closed, BookDataStatus, config-governed thresholds, static vs temporal signals                              |
| `MicroBurstContextBuilder.ts`         | Closed candle filtering, fail-closed validation, port interfaces, data quality diagnostics                       |
| `MicroBurstEntryPolicy.ts`            | Room/risk gates, no fallback stop/target, leverage/diagnostics carry-through                                     |
| `MicroBurstExitPolicy.ts`             | Price-based trailing/break-even, correct priority ordering                                                       |
| `MicroBurstStrategy.ts`               | Leverage/positionFraction in diagnostics                                                                         |
| `MicroBurstPositionManager.ts`        | Exit policy integration, configurable, ownership assert                                                          |
| `MicroBurstPositionManager.test.ts`   | Fixed BotState fixture, updated fallback tradeId                                                                 |
| `MicroBurstMomentumAnalyzer.test.ts`  | Fixed empty candle test                                                                                          |
| `MicroBurstExitPolicy.test.ts`        | Rewritten for new context/policy signatures                                                                      |
| `MicroBurstEntryPolicy.test.ts`       | Updated for new types and assertions                                                                             |
| `MicroBurstSupportResistance.test.ts` | Added availableAtCandleIndex test, pivot config test                                                             |
| `MicroBurstStrategy.test.ts`          | Added leverage diagnostics test                                                                                  |

## Invariants preserved

- `MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = FALSE`
- `MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED = FALSE`
- No pyramiding introduced
- No strategy flip introduced
- No Aegis/Momentum behavior modified
- No lookahead in context builder
- No synthetic order book
- No silent fallback on missing data
- Ownership ambiguity fails closed

## Validation

- TypeScript build: PASS
- Full test suite: 808/808 PASS
- Micro-burst tests: 44/44 PASS
