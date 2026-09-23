# Prospective CURRENT/Candidate Capture Protocol

This is an observation-only protocol. It does not authorize entries, exits,
stops, cancellations, or any exchange mutation.

## Current Integration Point

The current runtime path is intentionally not wired to the capture adapter:

- `MicroBurstRuntime` creates an entry intent and calls `liveTrading.open` at
  `src/strategies/micro-burst/application/MicroBurstRuntime.ts:794-817`.
- That port currently returns only `boolean`; it does not provide an authoritative
  order ID, fill quantity, fill price, fees, or funding.
- `outcomeTracker.trackSignal` at `:837-925` records prospective signal outcomes,
  but is not an executed-entry/fill reconciler and cannot be used to claim fills.
- `MicroBurstProspectiveExitCapture` is the explicit boundary for a future
  reconciler. It is disabled unless constructed with `{ enabled: true }` and has no
  exchange, order, logger, or REST dependency.

## Event Contract

An observer-only composition must call these methods from already authoritative
execution reconciliation and market-data code:

1. `onExecutedEntry(identity, fills)` after the real entry fill is confirmed. The
   identity includes symbol, side, quantity, entry price, entry time, strategy/code
   version, and config hash. Fills are retained separately from hypothetical
   decisions.
2. `onRealFill(entryId, fill)` for later partial/additional real fills.
3. `onObservation(entryId, observation)` with the exact context already consumed by
   the market-data path. It includes event, receive, and evaluation timestamps,
   full-quantity depth evidence, BTC/flow/structure/quality provenance, execution
   assumptions, and optional real order/fill metadata.
4. `onRealPositionClosed(entryId, closedAtMs)` when the real position is reconciled
   flat. This does not stop observation; both simulations continue to their
   independent horizon.

The same observation is passed to independent CURRENT and CANDIDATE states. Their
stops and decisions are never shared. A real order/fill is metadata only and never
becomes a hypothetical fill.

## Persistence And Restart

`MicroBurstProspectiveExitJsonlStore` appends bounded snapshots with a 64 MiB
default cap. The latest valid snapshot per `entryId` is loaded on restart and
`restore()` reconstructs both policy states, stops, decisions, real fills, real
close time, and identity. Corrupt rows are skipped and surfaced through store
health. A full store or failed write returns failure metrics and does not throw into
the trading path.

The `entryId` is the operation identity, not the symbol. A second BTCUSDT operation
therefore cannot overwrite the first episode.

## Execution Uncertainty

- A stop decision is not a stop activation and neither is a fill.
- The observer never replaces a hypothetical exit with the stop price.
- If a stop or target is crossed between two supplied observations, the affected
  simulation is marked `NO_EVALUABLE` because order of touch and fill price are
  unresolved.
- Missing depth coverage, causal gaps, invalid timestamps, missing economics, or
  missing assumptions mark the affected segment/result `NO_EVALUABLE`.
- The observer does not query later history to repair a missing interval.

## Activation Procedure

Current state: **PREPARED, DISABLED**.

1. Keep `MicroBurstProspectiveExitCapture` unconstructed in the normal runtime, or
   construct it without `enabled: true`.
2. Build a separate observer-only composition that receives reconciled fills and
   already-consumed market snapshots; never pass `liveTrading`, exchange, order, or
   position-authority ports to it.
3. Freeze and record the CURRENT/candidate policy versions, config hash, code SHA,
   cost assumptions, maximum entries, observation cap, and journal path.
4. Enable only that composition with `{ enabled: true }`, while leaving the LIVE
   strategy configuration and order path unchanged.
5. Disable by stopping that composition or removing `{ enabled: true }`; do not
   change the strategy policy to disable observation.

Before collecting results, require all eligible episodes, report coverage and
exclusions, compare paired net PnL/risk under the same cost assumptions, and retain
`NO_EVALUABLE` rates. Longer holding or favorable-only fixtures are not evidence of
improvement.
