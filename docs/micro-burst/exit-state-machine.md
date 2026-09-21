# Micro Burst Offline Exit State Machine

This document specifies the phase 3 research-only exit variant. It is not a LIVE
policy and must not be imported by the runtime exit adapter.

## Invariants

- Structural invalidation, anomaly, crossed stop, and absolute exposure limit have
  priority over strategic state.
- A target is closed only when the executable quote is quantity-covered and its
  estimated net return is positive.
- The strategic reevaluation at `exitMaxHoldMs` is not a time-only close.
- `MAX_HOLD` remains the independent hard exposure boundary at
  `exitMaxHoldMs + exitMaxHoldExtensionMs`.
- Market evidence must be fresh and advancing. Replaying the same observation does
  not increase confirmation count.
- Missing or stale executable economics produces `HOLD` with `PROBING`; it never
  invents a continuation or deterioration signal.

## States

| State                | Meaning                                                                                           | Exit behavior                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `PROBING`            | Evidence is unavailable, neutral, early, or insufficiently aligned.                               | Hold while safety invariants remain valid.                                                  |
| `CONTINUING`         | Fresh evidence supports continuation and no qualified fast adverse source exists.                 | Hold and continue observation.                                                              |
| `TOLERABLE_PULLBACK` | Estimated net result is negative, but deterioration pressure is below the confirmation threshold. | Hold; reset deterioration persistence when evidence recovers.                               |
| `DETERIORATING`      | Fresh evidence meets the configured adverse-family, score, fast-source, and pressure gates.       | Hold until the same causal deterioration persists for the configured confirmation interval. |
| `CLOSING`            | A close decision has been confirmed.                                                              | Return the same decision on repeated evaluations.                                           |

## Transition priority

1. `CLOSING` is terminal and idempotent.
2. Invalid configuration, clock/prices, structural invalidation, anomaly, and
   crossed stop close immediately using the existing reasons.
3. The absolute exposure boundary closes with `MAX_HOLD`.
4. Positive executable target closes with `TARGET`.
5. Without fresh executable economics, transition to `PROBING` and hold.
6. Fresh advancing evidence is classified as `DETERIORATING`, `CONTINUING`,
   `TOLERABLE_PULLBACK`, or `PROBING`.
7. `DETERIORATING` closes only after two advancing observations, persistent causal
   adverse sources, and `exitIntelligenceConfirmationMs` elapsed.

## Exact timers

With `defaultMicroBurstConfig()` the effective values are:

| Purpose                          | Configuration                            |     Effective value | Candidate behavior                |
| -------------------------------- | ---------------------------------------- | ------------------: | --------------------------------- |
| Strategic reevaluation milestone | `exitMaxHoldMs`                          | `300000 ms` (5 min) | Reevaluate and may hold           |
| Absolute exposure limit          | `exitMaxHoldMs + exitMaxHoldExtensionMs` | `360000 ms` (6 min) | Mandatory `MAX_HOLD` close        |
| Deterioration confirmation       | `exitIntelligenceConfirmationMs`         |           `3000 ms` | Required before intelligent close |
| Evidence freshness               | `exitIntelligenceMaxObservationGapMs`    |          `15000 ms` | Older evidence is not evaluable   |

- `strategicReevaluationAtMs` is reconstructed as `enteredAtMs + exitMaxHoldMs`.
  Crossing it changes evaluation priority only; it does not close the position.
- `absoluteExposureDeadlineAtMs` is reconstructed as
  `enteredAtMs + exitMaxHoldMs + exitMaxHoldExtensionMs`. Crossing it closes with
  `MAX_HOLD` before economics or strategic evidence are considered.
- `stateSinceAtMs` changes only when the classified state changes. It is diagnostic
  and never restarts either deadline.
- `riskStartedAtMs` starts on the first qualified deterioration observation and is
  retained only while the next qualified observation has a persistent causal source
  and a gap no larger than `exitIntelligenceMaxObservationGapMs`.
- `lastEvidenceAtMs` prevents the same market-evidence timestamp from incrementing
  confirmation. A stale or missing economic quote sends the state to `PROBING`,
  retains the original deadlines, and does not refresh `lastEconomicObservedAtMs`.
- `lastEconomicObservedAtMs` is the timestamp of the accepted executable quote;
  reconstruction never treats a newly evaluated context as a newly observed quote.

## Transition table

| Guard                                                        | From             | To                   | Decision                         |
| ------------------------------------------------------------ | ---------------- | -------------------- | -------------------------------- |
| Already confirmed                                            | any              | `CLOSING`            | Return the stored close decision |
| Invalid contract, invalidation, anomaly, crossed stop        | any non-terminal | `CLOSING`            | Safety reason                    |
| `timeInTradeMs >= exitMaxHoldMs + exitMaxHoldExtensionMs`    | any non-terminal | `CLOSING`            | `MAX_HOLD`                       |
| Fresh covered quote reaches destination with positive net    | any non-terminal | `CLOSING`            | `TARGET`                         |
| Quote unavailable, stale, uncovered, or below cost floor     | any non-terminal | `PROBING`            | `HOLD` / `DATA_DEGRADED`         |
| Qualified adverse evidence, not yet confirmed                | any strategic    | `DETERIORATING`      | `HOLD`                           |
| Continuation evidence passes support gate                    | any strategic    | `CONTINUING`         | `HOLD`                           |
| Negative net estimate with pressure below adverse threshold  | any strategic    | `TOLERABLE_PULLBACK` | `HOLD`                           |
| Otherwise                                                    | any strategic    | `PROBING`            | `HOLD`                           |
| Qualified deterioration persists for count/time requirements | `DETERIORATING`  | `CLOSING`            | `INTELLIGENT_EXIT`               |

The candidate changes only strategic classification and confirmation. It does not
change safety precedence, executable pricing, sizing, leverage, order placement,
or LIVE configuration.

## Prospectively captured evidence

`MicroBurstProspectiveExitObserver` is a bounded research collector. Each
registered entry creates independent CURRENT and CANDIDATE state, stop, decision,
and horizon tracking. It continues recording supplied observations after the real
position closes and marks each hypothetical decision separately from any real order
or fill metadata. It has no exchange, order, logger, or REST dependency.

The observer is not wired into LIVE by default. A future integration must feed it
the already-consumed market snapshot and explicitly supplied provenance; it must not
query historical data to repair gaps. Missing depth coverage, causal gaps, invalid
timestamps, or missing execution assumptions mark the affected simulation
`NO_EVALUABLE`. Queue depth is fixed at zero because the collector performs no I/O.
Metrics expose accepted observations, validation failures, capacity drops,
discarded observations, `NO_EVALUABLE` entries, queue depth, and I/O errors.
