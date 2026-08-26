# Runtime Architecture Migration Status

Branch: `work/micro-burst-rider-v1-20260826`

This file tracks implementation progress. It does not grant live authority to a new strategy.

## Current checkpoint

Runtime architecture migration checkpoint after commit `453c5e1`.

The TypeScript build passes. The current Aegis live runtime suite passes 107/107 and the ExitEye suite passes 12/12. Shared strategy execution tests pass 8/8. Aegis execution intent factory tests pass 2/2. Aegis orchestrator tests pass 3/3. The full repository test command still has historical/environment failures caused by missing fixtures/artifacts and a missing audit database directory; these are tracked separately below and are not evidence of a current strategy-runtime regression.

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
- Momentum standalone entry is evaluated through `MomentumRideStrategy` and can execute through `SharedStrategyExecutionService` without requiring an Aegis entry approval.
- Momentum has its own runtime protection/risk settings instead of inheriting Aegis Turbo SL/TP/liquidity/daily-loss values by accident.
- Position lifecycle is routed by strategy identity and receives an explicit `StrategyLifecyclePolicy`.
- Aegis ExitEye authority is restricted to Aegis lifecycle policy; Momentum must not inherit Aegis ExitEye authority.
- Bracket lifecycle respects the strategy/config bracket requirement instead of forcing Aegis brackets when `require_brackets: false`.
- Portfolio exposure counting defensively rejects a LONG object returned by a SHORT lookup (and vice versa) so one position is not double counted.
- One-shot migration/audit workflows and scripts used during this phase have been removed after successful application.
- Proven-dead runtime compatibility files were removed, including old legacy runtime factory/compatibility/coordinator/telemetry adapters and obsolete `config/regimen.config.yaml`.
- Broken npm scripts whose target source files no longer existed were removed from `package.json`.

## Architecture currently in effect

### AEGIS_TURBO

Entry authority remains Aegis-specific:

`Aegis signal/current brain -> AegisEntryGuardOrchestrator -> E4/final Aegis safety -> approved Aegis entry`

Important: Aegis policy remains upstream of execution. Its scientific/current-brain/E4 semantics must not be moved into shared execution.

Position ownership is strategy-aware and routes to `AegisPositionManager`, but the manager currently delegates into the shared legacy-compatible lifecycle implementation inside `TradingService`.

Exchange mutation is now routed through `SharedStrategyExecutionService` via `AegisExecutionIntentFactory`. Per-intent protection policies are enforced at the shared execution boundary, with `closeIfProtectionFails` always true for Aegis (preserving legacy fail-close behavior). The orchestrator no longer carries any synthetic Momentum authority.

### MOMENTUM_RIDE

Standalone Momentum entry path exists independently:

`MomentumRideStrategy -> Momentum-owned limits/risk -> shared operational safety -> SharedStrategyExecutionService -> MomentumRidePositionManager`

This path must remain independent from Aegis current brain, CleanEntry, EntryQuality, DecisionBrain and E4 authority unless a future contract explicitly declares a shared account-level safety rule.

The synthetic Momentum-inside-Aegis decision path has been retired. The orchestrator no longer imports or evaluates `MomentumRideGuardAdapter`; it cannot select `momentum_ride`, override Aegis denials, or attribute Aegis-opened positions to Momentum. The `MomentumRideGuardAdapter` file has been removed. Config types for the standalone `aegis.momentum_ride` YAML section are retained in `AegisEntryDecisionTypes` for the standalone Momentum strategy path.

Position ownership routes to `MomentumRidePositionManager`, but that manager still delegates into the common lifecycle body in `TradingService` using `StrategyLifecyclePolicy` rather than owning a fully extracted lifecycle service.

## Highest-priority remaining work before Micro Burst

1. ~~**Migrate Aegis exchange mutation to `SharedStrategyExecutionService`.**~~ DONE
2. ~~**Remove the synthetic Momentum-inside-Aegis decision path.**~~ DONE

3. **Extract position lifecycle implementation out of `TradingService`.**
   - `AegisPositionManager` and `MomentumRidePositionManager` should become real owners, not thin delegates into one giant service method.
   - Common exchange-safe primitives can be shared, but strategy-specific policy must remain behind the owning manager.
   - Aegis-only ExitEye/guardian behaviors must be impossible to invoke for Momentum by construction.

4. **Make restart/recovery strategy-generic.**
   - Recover canonical `BOT` ownership.
   - Continue reading legacy `AEGIS` ownership only as migration compatibility.
   - Recover strategy identity/provenance and route to the correct position manager after restart.
   - Unknown/ambiguous owner must fail closed into recovery/manual handling, never guess a strategy.

5. **Finish per-strategy risk persistence/recovery.**
   - Runtime `StrategyRiskLedger` is strategy-scoped, but startup reconstruction must be audited carefully so Aegis and Momentum loss streaks/trade counts cannot contaminate each other.
   - Account-wide kill switches remain shared safety and must not be copied into strategy ledgers.

6. **Freeze/hash stabilized Aegis and Momentum runtime/config contracts.**
   - Do not mark `FROZEN_LIVE` merely because code compiles.
   - Generate deterministic hashes only after architecture and behavior are stable.

7. **Reduce `TradingService` responsibility.**
   - Target role: orchestration/runtime coordination, not strategy policy + execution + lifecycle + recovery all in one class.
   - Do this incrementally; do not rewrite the bot from scratch.

8. **Repair/triage repository-wide test infrastructure separately.**
   Current `npm test` historical failures are caused by missing assets/environment:
   - `tests/fixtures/brain_manifest.json` missing.
   - `config/bundles/aegis-v17-research-artifact-v1.json` missing.
   - `config/bundles/aegis-prospective-shadow-candidate-v1.json` missing.
   - `regime_config.example.yaml` missing for restoration tests.
   - `recentTradeLossAuditCore.test.ts` expects an audit DB directory that does not exist in clean CI.
   Do not fabricate scientific/frozen artifacts just to make tests green. Either restore authoritative artifacts from their legitimate source, make the tests explicitly fixture-aware, or classify/remove tests if the associated subsystem is formally retired.

9. **Only after all above, begin `MICRO_BURST_V1`.**

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
- `MICRO_BURST_V1` remains reserved only during Phase 1.
- Do not change E4 frozen scientific behavior while refactoring execution architecture.

## Validation checkpoint

At the latest runtime checkpoint:

- TypeScript build: PASS.
- `src/app/services/SharedStrategyExecutionService.test.ts`: 8/8 PASS.
- `src/domain/strategies/aegis/AegisExecutionIntentFactory.test.ts`: 2/2 PASS.
- `src/domain/services/aegis-entry/AegisEntryGuardOrchestrator.test.ts`: 3/3 PASS.
- `src/app/services/TradingService.aegis-live.test.ts`: 107/107 PASS.
- `src/app/services/TradingService.exit-eye.test.ts`: 12/12 PASS.
- Strategy router / position manager router / Momentum entry policy targeted tests: PASS in the cleanup validation.
- Full `npm test`: 852 passed, 10 failed; remaining failures are the missing historical fixtures/artifacts/audit DB listed above.

## Explicit prohibition

`MICRO_BURST_V1` remains a reserved ID only. It has no entry evaluator, no live router registration, no execution authority, and no position manager registration in this migration phase.
