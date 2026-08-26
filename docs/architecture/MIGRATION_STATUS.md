# Runtime Architecture Migration Status

Branch: `work/micro-burst-rider-v1-20260826`

This file tracks implementation progress. It does not grant live authority to a new strategy.

## Current checkpoint

Runtime architecture migration checkpoint after commit `d27f6f9`.

The TypeScript build passes. The required Phase 1 matrix passes 166/166, including Aegis live 108/108 and ExitEye 12/12. The full repository suite passes 819/821; both failures are the known restoration checks that require the absent root `regime_config.example.yaml` fixture.

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

## Highest-priority remaining work before Micro Burst

1. ~~**Migrate Aegis exchange mutation to `SharedStrategyExecutionService`.**~~ DONE
2. ~~**Remove the synthetic Momentum-inside-Aegis decision path.**~~ DONE

3. ~~**Extract position lifecycle implementation out of `TradingService`.**~~ DONE

4. ~~**Make restart/recovery strategy-generic.**~~ DONE

5. ~~**Finish per-strategy risk persistence/recovery.**~~ DONE WITH DOCUMENTED JOURNAL LIMITATION

6. **Freeze/hash stabilized Aegis and Momentum runtime/config contracts.**
   - Do not mark `FROZEN_LIVE` merely because code compiles.
   - Generate deterministic hashes only after architecture and behavior are stable.

7. **Reduce `TradingService` responsibility.**
   - Target role: orchestration/runtime coordination, not strategy policy + execution + lifecycle + recovery all in one class.
   - Do this incrementally; do not rewrite the bot from scratch.

8. **Repair/triage repository-wide test infrastructure separately.**
   Current `npm test -- --run` has two failures because root `regime_config.example.yaml` is absent from this checkout. Do not fabricate or copy an unauthoritative fixture merely to satisfy the frozen digest check; restore it only from its legitimate source or make the restoration test explicitly fixture-aware in a separate infrastructure change.

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
- Required Phase 1 targeted matrix: 166/166 PASS.
- `src/app/services/TradingService.aegis-live.test.ts`: 108/108 PASS.
- `src/app/services/TradingService.exit-eye.test.ts`: 12/12 PASS.
- `src/app/strategy/OwnedPositionManagers.test.ts`: 4/4 PASS.
- Strategy router / position manager router / Momentum entry policy / shared safety / ownership / risk ledger targeted tests: PASS.
- Full `npm test -- --run`: 819 passed, 2 failed. Both failures are caused by the absent root `regime_config.example.yaml`; no scientific artifact or replacement hash was fabricated.

## Explicit prohibition

`MICRO_BURST_V1` remains a reserved ID only. It has no entry evaluator, no live router registration, no execution authority, and no position manager registration in this migration phase.
