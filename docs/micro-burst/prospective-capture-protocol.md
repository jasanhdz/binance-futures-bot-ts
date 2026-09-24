# Prospective CURRENT/Candidate Capture Protocol

This is an observation-only protocol. It does not authorize entries, exits,
stops, cancellations, or any exchange mutation.

## Current Integration Point

The observer is composed into the real application runtime, but remains disabled
by default:

- `MicroBurstRuntime` creates an entry intent and calls `liveTrading.open` at
  `src/strategies/micro-burst/application/MicroBurstRuntime.ts:794-817`.
- That port currently returns only `boolean`; it does not provide an authoritative
  order ID, fill quantity, fill price, fees, or funding.
- `outcomeTracker.trackSignal` at `:837-925` records prospective signal outcomes,
  but is not an executed-entry/fill reconciler and cannot be used to claim fills.
- `StrategyComposition` creates an app-owned `MicroBurstProspectiveExitEventBus`
  and passes it to `TradingService`.
- `TradingService` publishes an entry only after `readRecoverableEntryPosition`
  and matching authoritative entry fills succeed. It publishes close only after
  the real close path reports confirmed flatness.
- `StrategyRuntimeCoordinator` creates the observer from that bus only when
  `prospectiveValidation.enabled` is true. It reads snapshots already consumed
  by `MicroBurstRuntime`; it does not add REST calls or an order port.
- `MicroBurstProspectiveExitCapture` remains the persistence boundary and has no
  exchange, order, logger, or REST dependency.

The integration boundary is demonstrated by
`MicroBurstProspectiveExitRuntime.test.ts`:
`onExecutedEntry` receives a reconciled entry and fill, `onRealFill` receives a
later fill, `onObservation` continues before and after `onRealPositionClosed`,
and both simulations reach their independent horizon. Runtime listeners invoke
capture asynchronously (`void` promise handling), so the event source is not
held waiting for JSONL persistence. The test source exposes no exchange, order,
or position-authority methods. The test proves the component contract; the
production composition is now present, but capture remains disabled by default.

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

`MicroBurstProspectiveExitJsonlStore` appends bounded incremental records asynchronously
with a 64 MiB default cap and a 1024-write pending queue. The latest valid snapshot per `entryId` is loaded on restart and
`restore()` reconstructs both policy states, stops, decisions, real fills, real
close time, identity, and the original consumed observations. Corrupt rows are skipped and surfaced through store
health. A truncated final JSONL row is separately reported as `truncatedRecords`.
A full store or failed write returns failure metrics and does not throw into the
trading path. Writes are serialized asynchronously; the source callback does not
wait for disk I/O. `save()` returns true only after the record is appended and
`datasync()` completes; a corrupt or incomplete existing file blocks subsequent
append and preserves the corrupt bytes for investigation. A missing journal is
reported separately from a read/permission error.

The on-disk format is explicitly versioned:

```json
{
  "formatVersion": 1,
  "recordType": "EPISODE_SNAPSHOT",
  "snapshot": { "observations": [] },
  "observations": [],
  "decisions": { "CURRENT": [], "CANDIDATE": [] }
}
```

The snapshot contains the latest episode state without duplicating observations
or decision histories; the record contains only observations and CURRENT/CANDIDATE
decisions added since the preceding durable record. The store uses the same
complete snapshot validator as the observer after applying increments, so an
incomplete observation or decision cannot replace the last valid episode. The
store reconstructs the latest snapshot per entry and the per-entry counts once
when opened, then appends from those indices. Each later save checks the expected
file size and modification time;
an external change blocks append and requires an explicit reload/review instead
of silently reparsing or merging unknown bytes.
The shared validator is total: malformed top-level objects, missing fields, and

`writeAllBytes()` retries short writes until the complete UTF-8 record is written
and rejects zero progress. The store advances its byte/observation/decision
indices only after the full write and `datasync()` succeed. Any write, close,
or datasync failure increments `writeFailures`, blocks further append, and does
not advance those indices; a possible partial tail is preserved for diagnosis.

The writer contract is single-writer per store instance: calls are serialized by
`writeTail`, and the in-memory indices describe only writes acknowledged by that
instance. The store does not acquire a cross-process filesystem lock and does
not exclude another writer. Size/mtime verification detects many external
changes before the next append, but it is not an exclusion mechanism and cannot
prove that no concurrent writer raced between verification and append. A
multi-process deployment therefore requires an external single-writer/lock
contract; this observer store does not provide that guarantee itself.
Rows without `formatVersion: 1`, legacy full-snapshot rows, and unknown record
types or versions are rejected as `incompatibleRecords`, set `appendBlocked`,
and are never silently migrated or rewritten. Existing operational files are
not modified. A future format requires an explicit reviewed reader or migration.

The `entryId` is the operation identity, not the symbol. A second BTCUSDT operation
therefore cannot overwrite the first episode.

## Execution Uncertainty

- A stop decision is not a stop activation and neither is a fill.
- The observer never replaces a hypothetical exit with the stop price.
- CANDIDATE inherits the CURRENT protection reducer for hard invalidation, stops,
  targets, protective stop movement, and absolute exposure safety. It filters only
  the temporary strategic close reasons under evaluation (`EARLY_FAILURE`,
  `INTELLIGENT_EXIT`, `BTC_REVERSAL`, `MAX_HOLD`) and then applies its offline
  continuation diagnostics. This is the intentional policy difference.
- If a stop or policy-specific target is crossed strictly between two supplied
  observations, the affected decision records `NO_EVALUABLE` with the exact prior
  and current event times because order of touch and fill price are unresolved.
- An exact target arrival at the current observation remains evaluable and is passed
  to the policy reducer. CURRENT uses observed current price; CANDIDATE uses the
  executable economics price for target evaluation.
- Missing depth coverage, causal gaps, invalid timestamps, or missing assumptions
  mark only the affected segment/result `NO_EVALUABLE`; later complete observations
  can continue the episode. Candidate economics that are unavailable follow the
  candidate policy's explicit `HOLD`/`DATA_DEGRADED` semantics rather than being
  converted into a fabricated exit. The first reason and timestamp remain in the
  simulation snapshot.
- The observer does not query later history to repair a missing interval.

## Activation Procedure

Current state: **PREPARED, DISABLED**.

1. Keep `prospectiveValidation.enabled` false (the current default).
2. The normal application composition already constructs the observer-only
   boundary. It receives reconciled fills and consumed snapshots through the bus;
   it never receives `liveTrading`, exchange, order, or position-authority ports.
3. Freeze and record the CURRENT/candidate policy versions, config hash, code SHA,
   cost assumptions, maximum entries, observation cap, and journal path.
4. Enable only that composition with `{ enabled: true }`, while leaving the LIVE
   strategy configuration and order path unchanged.
5. Disable by stopping that composition or removing `{ enabled: true }`; do not
   change the strategy policy to disable observation.

Exact prepared configuration:

```ts
const config = {
  enabled: false, // change only in the separately reviewed observer process
  journalPath: 'logs/micro-burst/prospective-exits.jsonl',
  maxJournalBytes: 64 * 1024 * 1024,
  maxPendingWrites: 1024,
  maxEntries: 256,
  maxObservationsPerEntry: 512,
};
const runtime = createMicroBurstProspectiveExitRuntime(config, reconciledEventSource);
await runtime.start();
```

The event source emits `onExecutedEntry` only after authoritative fill
reconciliation, then `onRealPositionClosed` and consumed observations. The bus
records synchronous listener cost (`publishCount`, `totalMs`, `maxMs`); this is
the relevant latency measure because `void promise` alone is not a latency proof.

The production points are now:

- Entry/fill source: `TradingService.publishReconciledMicroBurstEntry`, which
  rejects intent/ACK-only data and requires the recoverable-entry contract plus
  matching fills.
- Observation source: `StrategyRuntimeCoordinator.publishProspectiveObservations`,
  reading the snapshot already consumed by `MicroBurstRuntime`.
- Close source: the identified close path after its confirmed-close result.

Do not substitute entry intent, `outcomeTracker.trackSignal`, or an ACK for these
sources. Slow disk and a full queue are isolated by the asynchronous bounded store;
the synchronous bus metric must be reviewed separately. Restart restores persisted
episodes, while a position that was already active before the observer started is
not fabricated into a new episode without fresh authoritative entry evidence.

Before collecting results, require all eligible episodes, report coverage and
exclusions, compare paired net PnL/risk under the same cost assumptions, and retain
`NO_EVALUABLE` rates. Longer holding or favorable-only fixtures are not evidence of
improvement.
