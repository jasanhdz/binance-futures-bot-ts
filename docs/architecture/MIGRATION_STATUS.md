# Runtime Architecture Migration Status

Branch: `work/micro-burst-rider-v1-20260826`

This file tracks implementation progress. It does not grant live authority to a new strategy.

## Current checkpoint

Runtime architecture migration checkpoint after MICRO_BURST_V1 M0.3 exact structural protection.

Validation results are recorded below. This checkpoint does not grant runtime authority.

## Completed foundations

- Canonical strategy identity contract in `src/domain/strategy/StrategyIdentity.ts`.
- Canonical decision/execution/lifecycle contracts under `src/domain/strategy/`.
- `StrategyRouter` for strategy-owned entry evaluation.
- `PositionManagerRouter` for strategy-owned position lifecycle routing.
- `AegisPositionManager` and `MomentumRidePositionManager` ownership boundaries.
- Strategy-aware telemetry/provenance fields.
- Persisted strategy version/hash/config hash/code SHA/freeze-state fields on bot state.
- Strategy-prefixed trade IDs for new Aegis and Momentum trades.
- Canonical new bot ownership marker is `positionOwner: BOT`.
- Legacy persisted `positionOwner: AEGIS` remains readable for recovery compatibility only.
- `StrategyRiskLedger` provides independent per-strategy trades/day, loss streak, last entry/exit/loss and cooldown timing.
- Aegis entry context now consumes Aegis-owned risk counters instead of sharing Momentum counters.
- Momentum standalone entry consumes Momentum-owned risk counters.
- `SharedEntrySafetyGate` remains the shared operational safety boundary.
- `SharedStrategyExecutionService` exists as the strategy-neutral exchange mutation boundary.
- Shared execution accepts either the existing ROE stop path or one exact absolute structural stop, rejects ambiguous dual specifications, validates structural geometry against the confirmed fill after exchange rounding, and fails closed through the existing protection recovery path.
- Momentum standalone entry is evaluated through `MomentumRideStrategy` and can execute through `SharedStrategyExecutionService` without requiring an Aegis entry approval.
- Momentum has its own runtime protection/risk settings instead of inheriting Aegis Turbo SL/TP/liquidity/daily-loss values by accident.
- Position lifecycle is routed by strategy identity and receives an explicit `StrategyLifecyclePolicy`.
- The common lifecycle body lives in `StrategyPositionLifecycleCore`, outside `TradingService`.
- `AegisPositionManager` owns the Aegis lifecycle composition with ExitEye; `MomentumRidePositionManager` cannot receive ExitEye through its construction path.
- Manual/external positions retain common protective management without entering a strategy manager or receiving Aegis ExitEye authority.
- Ownership recovery distinguishes owned, legacy-migratable, ambiguous, external and unknown state; ambiguous/unknown ownership fails closed.
- Startup risk reconstruction reads verified Aegis and Momentum closes independently and deduplicates by trade ID.
- Closed outcomes reconstruct loss streak/last-loss state but do not fabricate `tradesToday`, because a close journal alone does not prove an open occurred in the current UTC day.
- Bracket lifecycle respects the strategy/config bracket requirement instead of forcing Aegis brackets when `require_brackets: false`.
- Portfolio exposure counting defensively rejects a LONG object returned by a SHORT lookup (and vice versa) so one position is not double counted.
- One-shot migration/audit workflows and scripts used during this phase have been removed after successful application.
- Proven-dead runtime compatibility files were removed, including old legacy runtime factory/compatibility/coordinator/telemetry adapters and obsolete `config/regimen.config.yaml`.
- Broken npm scripts whose target source files no longer existed were removed from `package.json`.

## Phase 1 Cleanup (Archived)

The following cleanup tasks were completed to stabilize architecture before Micro Burst:

- **Shared execution relocated** to `src/app/execution/SharedStrategyExecutionService.ts`.
- **EntryStrategy** moved to `src/domain/strategy/EntryStrategy.ts`.
- **Formatter** moved to `src/app/telegram/presentation/AegisTurboEntryMessageFormatter.ts`.
- **Legacy research modules** archived:
  - `src/brain` → `src/tooling/research/archived/brain-contract-v1/`
  - `src/prospective` → `src/tooling/research/archived/prospective-shadow-cohort-v1/`
  - `src/challengers` → `src/tooling/research/archived/challengers-v17/`
- **Legacy execution** archived:
  - `src/execution-durable` → `src/tooling/legacy-execution/durable/`
- **Sentinel integration** archived:
  - `src/sentinel` → `src/tooling/research/archived/sentinel-news-v1/`
  - `enable_sentinel` config option removed.
- **Backtest directory** removed (contained only mock tests, no runner).
- **Auditors** relocated to `src/tooling/audit/binance-usdm-readonly/`.
- **Analyzer** moved to `src/app/analysis/AegisTurboHistoryAnalyzer.ts`.
- **Aegis tools** moved to `src/tooling/aegis/`.
- **Documentation** reorganized:
  - `docs/README.md` added.
  - Aegis docs under `docs/strategies/aegis/` and `docs/operations/aegis/`.
  - Historical docs under `docs/history/`.
  - Aegis Range archived under `docs/research/archived/aegis-range-v1/`.
- **Vitest config** added with `testTimeout: 15000` to accommodate lifecycle tests with filesystem I/O.
- **`package.json`** normalized: `main` now points to `dist/main.js`.
- **Restoration tests** use real `config/regime_config.example.yaml` fixture.
- **Phase 1 architecture boundary test** added at `src/restoration/phase1-architecture-boundaries.test.ts`.
- **Digests** updated: `23e210a84d4f547588e899d345d13905e4084a685346794c96f2cf2429e17fc6`, `43546401954d3c79b56b29a8156411815679c63977799884cb58d7c6a78c7324`.

## Architecture currently in effect

### AEGIS_TURBO

Entry authority remains Aegis-specific:

`Aegis signal/current brain -> AegisEntryGuardOrchestrator -> E4/final Aegis safety -> approved Aegis entry`

Important: Aegis policy remains upstream of execution. Its scientific/current-brain/E4 semantics must not be moved into shared execution.

Position ownership is strategy-aware and routes to `AegisPositionManager`, which composes `StrategyPositionLifecycleCore` with the Aegis-only ExitEye callback.

Exchange mutation is now routed through `SharedStrategyExecutionService` via `AegisExecutionIntentFactory`. Per-intent protection policies are enforced at the shared execution boundary, with `closeIfProtectionFails` always true for Aegis (preserving legacy fail-close behavior). The orchestrator no longer carries any synthetic Momentum authority.

### MOMENTUM_RIDE

Standalone Momentum entry path exists independently:

`MomentumRideStrategy -> Momentum-owned limits/risk -> shared operational safety -> SharedStrategyExecutionService -> MomentumRidePositionManager`

This path must remain independent from Aegis current brain, CleanEntry, EntryQuality, DecisionBrain and E4 authority unless a future contract explicitly declares a shared account-level safety rule.

The synthetic Momentum-inside-Aegis decision path has been retired. The orchestrator no longer imports or evaluates `MomentumRideGuardAdapter`; it cannot select `momentum_ride`, override Aegis denials, or attribute Aegis-opened positions to Momentum. The `MomentumRideGuardAdapter` file has been removed. Config types for the standalone `aegis.momentum_ride` YAML section are retained in `AegisEntryDecisionTypes` for the standalone Momentum strategy path.

Position ownership routes to `MomentumRidePositionManager`, which owns its policy composition over `StrategyPositionLifecycleCore` and has no ExitEye callback surface.

### MICRO_BURST_V1 (M0.3 exact structural protection)

Deterministic tactical strategy contract implemented. Mode remains OFF. SHADOW and LIVE authority are explicitly false.

```
MicroBurstContextBuilder -> MicroBurstEntryPolicy -> Shared Safety -> SharedStrategyExecutionService -> MicroBurstPositionManager
```

Key properties:

- Deterministic replay via explicit snapshot time, closed-candle filtering, causal S/R, typed BTC timestamps, and typed book status
- Direction-aligned entry via S/R + micro-momentum + required BTC and order-book context
- Two leverage tiers: HIGH (40x, >=0.75 confirmation) and MEDIUM (20x, >=0.50)
- Structural-price invalidation, time-to-prove, target, software trailing, idempotent break-even, and max hold
- Uses `MICRO_BURST_RESERVED_POLICY`: no guardian, no break-even, no trailing in lifecycle
- No Aegis dependencies (no Current Brain, E4, ExitEye)
- Position manager computes/translates exits while OFF but applies no lifecycle/exchange mutation
- Registered in StrategyRouter and PositionManagerRouter but mode remains OFF
- Execution intent preserves `structuralStopPrice` as an absolute price through shared execution; no ROE conversion is permitted
- Structural stop geometry is validated after the real fill and tick rounding; protection failure triggers emergency close
- `destinationPrice` remains software-exit policy and does not become exchange take profit
- No Micro Burst production execution call site exists

## Remaining work before Micro Burst live authority

1. ~~**Migrate Aegis exchange mutation to `SharedStrategyExecutionService`.**~~ DONE
2. ~~**Remove the synthetic Momentum-inside-Aegis decision path.**~~ DONE
3. ~~**Extract position lifecycle implementation out of `TradingService`.**~~ DONE
4. ~~**Make restart/recovery strategy-generic.**~~ DONE
5. ~~**Finish per-strategy risk persistence/recovery.**~~ DONE WITH DOCUMENTED JOURNAL LIMITATION
6. ~~**Phase 1 Cleanup and archive reorganization.**~~ DONE
7. ~~**MICRO_BURST_V1 scaffold implementation.**~~ DONE (mode OFF, no live authority)
8. ~~**MICRO_BURST_V1 M0.2 correctness patch.**~~ DONE (deterministic/fail-closed contracts, no authority)
9. ~~**MICRO_BURST_V1 M0.3 exact structural protection.**~~ DONE (shared execution boundary only, mode OFF)
10. **Freeze/hash stabilized Aegis and Momentum runtime/config contracts.**
   - Do not mark `FROZEN_LIVE` merely because code compiles.
   - Generate deterministic hashes only after architecture and behavior are stable.
11. **Reduce `TradingService` responsibility.**
   - Target role: orchestration/runtime coordination, not strategy policy + execution + lifecycle + recovery all in one class.
   - Do this incrementally; do not rewrite the bot from scratch.
12. **MICRO_BURST_V1 M1 Market Data Plane.**
    - Add synchronized depth snapshot/diff handling, BTC stream, ticker/reference price, aggTrade and temporal book history.
    - Do not grant SHADOW or LIVE authority as part of data-plane construction.
13. **MICRO_BURST_V1 tuning and validation.**
    - Tune S/R detection parameters for real market conditions.
    - Tune momentum thresholds and leverage tiers based on backtesting.
    - Add BTC context pipeline to MicroBurstContextBuilder (currently null in production).
    - Wire order book depth to MicroBurstContextBuilder.
    - Validate exit policy timing parameters.
14. **MICRO_BURST_V1 live authority activation.**
    - Only after tuning, testing, and explicit approval.

## Explicit architecture invariants

- Strategy decides; shared safety can veto; shared execution executes. Shared execution never invents a strategy decision.
- A strategy cannot mutate another strategy's open position.
- A strategy cannot consume another strategy's loss streak/trade counter as if it were its own.
- Account-wide risk remains account-wide and may veto every strategy.
- Strategy-specific risk remains strategy-specific.
- Every opened bot trade carries strategy identity/provenance.
- Unknown ownership/recovery ambiguity fails closed.
- No pyramiding/strategy flip is introduced by this migration.
- No new live strategy authority is introduced accidentally.
- `MICRO_BURST_V1` remains OFF with SHADOW/LIVE authority disabled.
- Do not change E4 frozen scientific behavior while refactoring execution architecture.

## Validation checkpoint

At the latest runtime checkpoint:

- TypeScript build: PASS.
- Micro Burst M0.2 correctness tests: 12/12 files, 97/97 PASS.
- Micro Burst M0.3 tests: 12/12 files, 98/98 PASS.
- M0.3 Aegis/Momentum/Micro Burst targeted matrix: 17/17 files, 240/240 PASS.
- Full M0.3 suite: 83/83 files, 878/878 PASS.
- Full clean-worktree suite: 83/83 files, 861/861 PASS.
- `src/app/execution/SharedStrategyExecutionService.test.ts`: 24/24 PASS at M0.3.
- `src/domain/strategies/aegis/AegisExecutionIntentFactory.test.ts`: 2/2 PASS.
- `src/domain/services/aegis-entry/AegisEntryGuardOrchestrator.test.ts`: 3/3 PASS.
- Required Phase 1 targeted matrix: 170/170 PASS.
- `src/app/services/TradingService.aegis-live.test.ts`: 108/108 PASS.
- `src/app/services/TradingService.exit-eye.test.ts`: 12/12 PASS.
- `src/app/strategy/OwnedPositionManagers.test.ts`: 4/4 PASS.
- MicroBurst M0.1 hardening baseline: 44/44 PASS (superseded by M0.2 coverage).
- Strategy router / position manager router / Momentum entry policy / shared safety / ownership / risk ledger targeted tests: PASS.
- Restoration/fronteras: 23/23 PASS.
- Full `npm test -- --run`: 861 passed, 0 failed at M0.2.

## M0.1 Hardening (superseded by M0.2)

MICRO_BURST_V1 M0.1 hardening completed. All 24 items addressed:

### Types & conventions

- Price returns in decimal (0.001 = 0.1% = 10 bps), ROE in decimal (0.10 = 10%).
- `BookDataStatus` enum: HEALTHY | UNAVAILABLE | STALE | UNSYNCED | ANOMALOUS.
- `BookPressureSignal.imbalanceSlope` is `number | null` — null when only single snapshot available.
- Renamed `absorptionDetected`/`sweepDetected` → `staticBidConcentration`/`staticAskConcentration` (static proxies, not temporal).
- `SupportResistanceLevel.availableAtCandleIndex` — internal confirmation metadata; M0.2 added real `pivotAtMs` and `availableAtMs` causal timestamps.

### Config governance

- `srLookbackBars` separates from `srPivotLeftBars`/`srPivotRightBars`.
- `nearLevelThresholdBps` used by context builder (was hardcoded at 50).
- `momentumSlopePeriod` used by momentum analyzer (was hardcoded at 5).
- `bookMinImbalance` used by book pressure analyzer (was hardcoded at 0.5).
- `structuralInvalidationBufferBps` used for stop placement (was hardcoded at 0.3%).
- `minRoomBps` enforced as entry gate (was absent).
- `maxLeverageHardCap` enforced (50x default).

### Context validity

- `DataQualityDiagnostics` with `contextValid`, `invalidReasons`, `candleFreshnessMs`, `bookAgeMs`, `btcAgeMs`.
- Closed candle filtering: only candles older than their interval are used.
- Fail-closed: insufficient candles, stale data, unhealthy book → `contextValid: false`.
- Entry policy rejects `contextValid: false`.

### Entry policy

- No fallback stop/target without structural level.
- Room gate: `roomToTargetBps >= minRoomBps`.
- Risk gate: `riskToInvalidationBps` computed.
- Leverage/positionFraction carried into `StrategyEvaluationResult.diagnostics`.

### Exit policy

- Price-based trailing (not ROE-based).
- Break-even uses price comparison (not excursion comparison).
- Priority order: HARD_INVALIDATION → ANOMALY → BTC_REVERSAL → EARLY_FAILURE → TRAILING → BREAK_EVEN → MAX_HOLD → HOLD.
- `MicroBurstExitContext` includes `currentPrice`, `entryPrice`, `peakPrice`, `troughPrice`.

### Execution intent factory

- `createMicroBurstExecutionIntent()` converts approved entry to `StrategyExecutionIntent`.
- Preserves leverage, positionFraction, structuralStopPrice, destinationPrice.

### Position manager

- `MicroBurstPositionManager.evaluateExit()` integrated with exit policy.
- Ownership assertion with clear error message.
- Configurable via constructor.

### Strategy class

- Carries leverage/positionFraction/leverageTier/roomToTargetBps/riskToInvalidationBps into diagnostics.

## Explicit prohibition

`MICRO_BURST_V1` M0.1 hardening completed. Mode defaults to OFF. No live authority is enabled. Entry policy, exit policy, position manager, and lifecycle are hardened with fail-closed semantics. Live/shadow authority activation requires explicit approval after tuning and backtesting.
