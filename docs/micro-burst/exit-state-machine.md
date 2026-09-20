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
