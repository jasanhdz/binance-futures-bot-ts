# Runtime Architecture Migration Status

Branch: `work/micro-burst-rider-v1-20260826`

This file tracks implementation progress. It does not grant live authority to a new strategy.

## Completed foundations

- Canonical strategy identity contract.
- Strategy decision envelope.
- `StrategyRouter`.
- `PositionManagerRouter`.
- Strategy-aware telemetry fields.
- Persisted strategy provenance fields on bot state.
- Shared operational entry safety gate.
- Strategy-specific position ownership routing in `TradingService`.
- Strategy-prefixed trade IDs for new Aegis/Momentum trades.
- `StrategyRiskLedger` for independent per-strategy counters/streaks/cooldowns.
- `SharedStrategyExecutionService` as strategy-neutral exchange mutation boundary.
- Concrete `MomentumRideStrategy` adapter.
- Explicit lifecycle policy: Aegis ExitEye is Aegis-only; Momentum does not inherit it.

## Still using compatibility paths

### AEGIS_TURBO

- Entry evaluation remains in the existing Aegis flow.
- Execution remains inside legacy `TradingService` code.
- Position management is routed by ownership but still delegates to legacy management.

### MOMENTUM_RIDE

- Pattern discovery is standalone and deterministic.
- The runtime still needs to be switched from the synthetic Aegis candidate path to `MomentumRideStrategy` directly.
- The runtime still needs to call `SharedStrategyExecutionService` directly.
- Its position manager still delegates to the legacy management body; lifecycle policy must be applied there so Aegis ExitEye cannot touch Momentum positions.

## Required before Micro Burst begins

1. Route Momentum entry directly through `MomentumRideStrategy`.
2. Use per-strategy risk ledger for Momentum limits.
3. Route Momentum approved intent directly to shared execution.
4. Apply lifecycle policy in position management and disable Aegis ExitEye for Momentum.
5. Move Aegis exchange mutation into shared execution while preserving Aegis-specific policy upstream.
6. Extract Aegis and Momentum position managers from the legacy body.
7. Confirm restart/recovery preserves strategy owner and provenance.
8. Freeze/hash stabilized Aegis and Momentum runtime/config manifests.
9. Stabilize build/tests/recovery fixtures.
10. Only then implement `MICRO_BURST_V1`.

## Explicit prohibition

`MICRO_BURST_V1` remains a reserved ID only. It has no entry evaluator, no live router registration, no execution authority, and no position manager registration in this migration phase.
