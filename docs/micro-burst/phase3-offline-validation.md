# Micro Burst Phase 3 Offline Validation

Date: 2026-09-20

This report separates implementation, test coverage, comparison, and economic
evidence. The candidate remains research-only.

## Status

| Area                   | Status             |
| ---------------------- | ------------------ |
| Phase 3 implementation | COMPLETE           |
| Technical review       | COMPLETE           |
| Economic evidence      | PENDING            |
| Prospective capture    | PREPARED, DISABLED |

## Implementation: COMPLETE

- `MicroBurstOfflineExitVariant` implements explicit `PROBING`, `CONTINUING`,
  `TOLERABLE_PULLBACK`, `DETERIORATING`, and terminal `CLOSING` states.
- Strategic reevaluation at `exitMaxHoldMs` does not close by time alone.
- Absolute exposure remains `exitMaxHoldMs + exitMaxHoldExtensionMs`.
- Safety checks remain first: invalid contract, structural invalidation, anomaly,
  crossed stop, and absolute exposure.
- State reconstruction persists state/deadline/evidence/economic-age diagnostics.
- No runtime adapter, LIVE configuration, stop, target, extension, sizing, leverage,
  or journal path imports the candidate.
- `MicroBurstProspectiveExitObserver` is prepared as a bounded, pure collector;
  activation is disabled and requires a separate adapter review.
- `MicroBurstProspectiveExitCapture` and its bounded JSONL store define the
  reconciled-entry/fill, post-close observation, and restart boundary without
  receiving order authority.

## Coverage: COMPLETE

The directed offline suites cover mirrored LONG/SHORT behavior for:

- favorable continuation through strategic and proof milestones;
- deterioration-confirmed early red exits;
- tolerable pullbacks and safety precedence;
- bounded neutral waiting without deadline restart;
- repeated observations without confirmation inflation;
- degraded economics and missing evidence;
- JSON reconstruction, deterioration timers, and quote age;
- invalidation, anomalies, and absolute exposure.

Current directed result: `37/37` tests passing.

## Comparison: COMPLETE FOR AVAILABLE FIXTURES

`MicroBurstOfflineExitComparison` replays identical timestamped observations into
CURRENT and the candidate. It now emits each action/reason divergence with:

- observation time;
- both actions, reasons, and diagnostics;
- both time-in-trade values;
- both executable-economics timestamps.

The comparison rejects invalid chronology, missing/stale/uncovered quotes,
unmodeled stop management, and open horizons instead of fabricating outcomes.
The checked fixtures demonstrate the expected strategic divergence at the current
hold milestone: CURRENT closes while the candidate holds; the candidate later
reaches the same absolute `MAX_HOLD` boundary.

No complete production exit-context replay containing all required post-close
inputs is present in the repository. Historical shadow trade/event logs do not
contain the complete executable economics and causal context required by this
comparator. Therefore no production replay is claimed here; such cases are marked
explicitly as `alternativeOutcome: NO_EVALUABLE`, not evidence for or against the
candidate.

## Economic Evidence: NOT EVALUATED

All results are decision-quote marks only. There is no fill simulator, alternate
execution, post-close continuation path, or claim of profitability improvement.
Longer holding time is not treated as economic improvement.

## Remaining TODO

- [ ] Export complete, causally aligned exit-context replays after future research
      runs and run the comparator over every eligible position.
- [ ] Review every divergence with action, reason, evidence age, and timing.
- [ ] Keep incomplete post-close histories explicitly `NO_EVALUABLE`.
- [ ] Do not promote the candidate to LIVE without separate approval and economic
      evidence.
- [ ] Keep prospective capture disabled until the adapter can provide complete
      event/receive/evaluation timestamps, full-depth quotes, and causal gaps.
- [ ] Activate only the separate observer-only composition described in
      `docs/micro-burst/prospective-capture-protocol.md`.
