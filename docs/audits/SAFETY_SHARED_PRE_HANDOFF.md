# Shared Pre-Handoff Behavior And Ownership Gap

## Scope

Original increment: tests and documentation only. The follow-up below adds live
Shared/recovery exclusion and drain, not durable emergency-close transfer.
Emergency policy, journal protocols, composition, managed Micro close/disconnect
corrections and architecture checkpoints are unchanged.
Automatic durable Shared pre-handoff closure remains NOT IMPLEMENTED.

The rejected local increment was withdrawn with apply_patch: the blanket Shared
Micro close/cancel suppression, entry quarantine API/replay fence, six supporting
tests, and their documentation claims were removed. It was incorrect to replace
closeIfProtectionFails for confirmed exposure with a permanent fence, or disable
evidence-validated MicroEntryRecoveryService. No operational journal was used by
that increment; this withdrawal introduces no migration or downgrade contract.

## Behavior Preserved

- Shared with both DurableEntryCoordinator and DurableStopCoordinator retains
  emergency risk reduction when a confirmed position has invalid structural stop
  geometry. LONG and SHORT tests establish that market open has completed, the
  geometry failure occurs BEFORE stop submission, and closeSideMarketSafe is called
  with the observed position quantity/mode. An empty protective-order listing and
  post-close null are fixture observations, not new durable closure guarantees.
- An initial durable stop returning false is different: lost ACK with hidden lookup
  evidence or stale protection identity yields protectionPending with exposure
  retained and no emergency close/cancel. Existing exact-lookup/restart/no-resend
  cases are preserved and strengthened to keep the entry handoff pending.
- Missing position confirmation after a confirmed entry receipt takes the existing
  conservative path when emergency reconciliation also returns null: no speculative
  close/cancel, positionStillOpen=true and closeAmbiguous=true. These fields report
  unresolved exposure, not a positive fresh-position observation.
- Startup entry recovery remains reachable. Tests close/reopen the actual entry
  journal after that Shared failure and register the real MicroEntryRecoveryService
  with the real PositionProtectionService and durable stop coordinator. Missing,
  failed or partial entry attribution leaves the blank projection untouched and
  sends no stop. Later exact entry evidence can reconstruct and protect it.
- Exact recovered evidence creates one durable stop, not a second market open or
  a legacy stop/close. Recovered accounting remains unverified and the entry remains
  pending under the fixture's deliberately unsatisfied confirmHandoff callback.
  Protecting exposure is not equivalent to verified accounting or released admission.

## Test Boundaries

The fixtures use the production-shaped BOTH-coordinator Shared configuration with
real coordinator/service classes, temporary filesystem journals and mocked exchange
ports. They do not invoke the production composition factories or a new complete
TradingService entry-OFF startup scenario. Existing full-suite tests cover managed
Micro close startup entry OFF separately. Recovery tests model a restart before
the caller persists a failure projection; they do not claim arbitrary occupied
projections are adoptable. Recovery still validates identity and refuses conflicts.

The partial-evidence case concerns entry attribution, NOT permission to retry a
partial market close. Initial-stop uncertainty is not relabeled a definite stop
rejection. Micro's normal policy still has no mandatory TP.

## Remaining Blocker

Shared's live intent and confirmed entry receipt precede the durable managed BOT
projection required by MICRO_CLOSE_V1. There is no explicit durable transfer from
the pending entry to a pre-handoff emergency close owner. Reusing the managed owner
by fabricating a projection is not justified. Suppressing emergency risk reduction
or automatic validated recovery is not a substitute for that transfer.

The existing pre-handoff close and subsequent BOT cleanup still use legacy direct
transports. Their durability, exact close identity, fresh-flat cancellation and
accounting settlement must not be inferred from the managed-close protocol.
A future implementation must preserve the definite-failure/uncertainty distinction,
exclude concurrent live handoff, persist identity before one identified close send,
use exact lookup without uncertain/partial resend, require fresh flat before exact
durable cancels, and retain entry/accounting ownership until valid settlement.
Startup recovery with entry OFF and shutdown drain must remain reachable.

No live exchange access, bot startup, env edit, commit or push. No deployment approval.

## Validation

Final `AEGIS_ENABLED=true npm run test:safety` PASS: build, 192 main files / 2,392
tests and separate ConfigLoader / 46 tests, **2,438 tests, zero failures**. This is
six behavior-preserving cases above the 2,432-test baseline, not retention of the
six withdrawn fence tests. Four existing stop cases were also strengthened.
Focused files: DurableEntryCoordinator 33 tests, MicroEntryRecoveryService 15 tests.

An initial focused failure exposed a fixture restoring attributed quantity without
restoring its separate position-read object; both observations now agree. Build
then caught two fixture type mismatches, corrected in tests only. Two subsequent
full-suite invocations were interrupted by the tool's wall-clock timeout; the final
complete invocation passed without changing test limits, assertions or runtime code.
No cause is assigned to those interruptions from the available evidence.

## Follow-Up: Live Ownership Exclusion Prerequisite

Durable transfer remains NOT IMPLEMENTED. Inspection found a concrete race ahead
of that protocol: DurableEntryCoordinator tracked only its entry execute task.
Once its confirmed receipt returned, Shared could still be awaiting position
confirmation, initial protection or emergency close while reconcile invoked
recoverPosition and confirmHandoff for the same pending entry.

Shared now wraps its entire execute body in withLiveHandoff, registered
synchronously in the coordinator's existing task set. An already-running recovery
finishes before this body starts; subsequent reconciliation skips the live body.
Shutdown drains that body before closing the entry writer. Fulfillment or rejection
releases only this in-memory exclusion, not journal admission or accounting.
Normal confirmHandoff validation inside entry execute is unchanged.

Four new tests cover both real entry/stop coordinators and filesystem journals
during held initial stop and held legacy emergency close, repeated reconciliation,
denied competing admission, one open/no duplicate mutation, writer-lock retention
during drain, and pending OPEN_CONFIRMED replay with recovery reachable on restart.
Two of the four cases specifically cover rejection releasing the live exclusion
and an already-running recovery completing before live work. The observation-error
case uses the exclusion API directly, not a production exchange outage scenario.
The original LONG/SHORT invalid-geometry, uncertain stop, entry fsync/lost-ACK and
attributable Micro recovery cases are preserved.

This is not the durable owner contract. In particular:

- The exclusion ends when Shared returns, before its caller persists a projection.
  It is not a lease covering the caller's complete handoff or a persisted transfer.
- DurableCloseCoordinator.requestFrom/same and PositionProtectionService cleanup
  and operational persistence still require the actual managed BOT identity. There
  is no valid pending-entry owner accepted by those paths, including cold replay.
- The next slice needs an evidence-bound transfer record in the entry journal,
  linked immutable close ownership, restart arbitration that cannot reconstruct or
  settle a transferred entry, and owner-aware exact cleanup/accounting persistence.
  A close call or fake BotState alone cannot safely provide those contracts.
- No new pre-handoff identified close, cross-journal fsync/restart protocol, fresh
  flat cleanup guarantee, partial-close retry, or entry-OFF transfer recovery is
  claimed. Existing unhandled Shared emergency and BOT cleanup transports remain
  explicitly legacy. No protection suppression or permanent recovery fence added.

Validation: focused entry/Shared/managed-close/Micro-recovery files PASS, 114 tests.
Final `AEGIS_ENABLED=true npm run test:safety` PASS: build, 195 main files / 2,457
tests plus ConfigLoader / 46, **2,503 tests, zero failures**, and diff check.
Only four new tests belong to this prerequisite; the workspace-wide count is not
attributed entirely to this change. An earlier full run reported 41 failures in
four untouched files (BTC context, Micro identity, Momentum entry, runtime
coordinator); those files passed isolated and on the final full rerun without edits
here. The observed full-run populations differed; no root cause is established.
The initial focused fixture omitted an async exact-stop lookup and was corrected.
No architecture hashes changed: no new mutation authority, port, adapter or
TradingService source change was needed. No commit/push/env edit/bot/live access.

## Interrupted-Task Reinspection

Worktree status was inspected before reading or editing. The existing live exclusion,
entry/stop behavior tests, Micro recovery tests and prior audit changes were preserved.
This continuation did NOT implement durable transfer or add transfer integration tests.
Only this audit and the handoff were updated; the requested implementation is incomplete.

The concrete unresolved contract spans three owners, not just the close transport:

- `DurableEntryCoordinator.finish` (lines 297-327) has only receipt/rejection and
  managed handoff outcomes. A new transfer must be recognized before reconstruction
  AND confirmHandoff; merely adding close metadata to CLOSE_PENDING does not prevent
  either operation or prove close settlement.
- `TradingService` (lines 1694-1728) consumes Shared failure metadata after the live
  exclusion ends. With positionStillOpen=true it writes a managed BOT projection.
  A transferred, uncertain close needs an explicit caller disposition so this write
  cannot create a competing owner. Reporting false instead would falsely claim flat.
- `DurableCloseCoordinator.requestFrom/same` and
  `PositionProtectionService.cleanupMicroCloseOrders` require managed BOT identity.
  Pending entry receipt plus exact fresh exposure cannot satisfy that contract without
  a distinct persisted owner. Cleanup and accounting persistence must accept that
  owner on cold replay, not require a synthetic managed projection.

No partial route was installed around these gaps. These are implementation contracts
still to build, not evidence of an external dependency or a reason to suppress existing
emergency risk reduction. The bounded confirmed-receipt/exact-exposure path remains a
valid intended scope, but requires linked cross-journal identity, crash arbitration,
caller disposition and terminal accounting ownership in one coherent increment.
Missing evidence must remain recoverable; ambiguous durable stop false must continue
to return protectionPending without emergency close. Both behaviors are unchanged.

Reinspection validation: `AEGIS_ENABLED=true npm run test:safety` PASS, build,
195 main files / 2,457 tests plus separate ConfigLoader / 46 tests, **2,503 tests,
zero failures**, including the existing managed close, startup entry-OFF and shutdown
coverage. These are existing tests, not proof of pre-handoff transfer. No architecture
checkpoint changes, operational journal access, env edits, commit, push or live access.
