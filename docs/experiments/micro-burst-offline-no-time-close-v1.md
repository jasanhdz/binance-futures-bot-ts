# Micro Burst Offline No-Time-Close V1

Status: research-only. This variant is not a runtime policy marker, is not loaded by the
production strategy, and has no exchange mutation authority.

## Audit Of CURRENT

The effective live contextual policy is `contextualPolicyVersion: MICRO`, even when the base
configuration is loaded from `defaultMicroBurstConfig()` or a persisted trade policy. YAML/env
exit-policy overrides are parsed by `MicroBurstConfigLoader`, then frozen into the contextual
trade policy by `createMicroBurstTradePolicy`; each trade carries that exact config and digest.
The relevant default values are:

| Control                    |         Effective default |
| -------------------------- | ------------------------: |
| Proof window               |                 60,000 ms |
| Proof extension            |                 30,000 ms |
| Strategic max-hold check   |                300,000 ms |
| Max-hold extension         |                 60,000 ms |
| Absolute wall-clock bound  |                360,000 ms |
| Estimated round-trip cost  |                    14 bps |
| Deterioration confirmation | 2 observations / 3,000 ms |

CURRENT can close `EARLY_FAILURE` at the end of the proof window or extension when the trade
has not reached the favorable excursion threshold and continuation is not eligible. It can
close `MAX_HOLD` at five minutes unless the assessment is profitable and continuation-eligible;
that condition can extend it to the six-minute absolute bound. The independent deadline helper
also closes at that absolute bound without market context.

CURRENT uses side-aware gross return, executable MFE/MAE, structural progress, estimated net
return, source-weighted continuation support, adverse pressure, and fresh market/book/BTC/flow
evidence. Missing executable economics causes a bounded degraded-data HOLD followed by ANOMALY;
it does not invent a quote. Structural invalidation, anomaly, crossed stop, and protection
uncertainty retain priority over strategy continuation. A historical state remains readable, but
the persisted policy values, not current process defaults, govern that trade.

The runtime uses the stateful `MicroBurstExitEngine` and persists/restores its state. The
offline outcome engine previously reused the same reducer but, without full market evidence,
could only produce a partial counterfactual. The new comparison helper requires timestamped
full contexts and leaves incomplete histories explicitly incomplete.

## Variant

`MICRO_OFFLINE_NO_TIME_CLOSE_V1` changes only the offline research reducer:

- The 300-second point is a `strategicReevaluationDue` diagnostic, not an automatic close.
- The 360-second existing bound remains an independent `MAX_HOLD` exposure limit.
- Lack of proof progress alone never produces `EARLY_FAILURE`.
- Strategic deterioration requires the existing adverse-source, pressure, age, and score gates,
  plus two advancing observations within the configured confirmation interval.
- A negative or positive PnL value is not itself a HOLD or CLOSE signal.
- Missing or stale executable economics produces a degraded HOLD and never claims continuation.
- Structural invalidation, anomaly, crossed stop, and the absolute exposure limit remain ahead of
  the variant's continuation decision.
- The variant does not move or widen stops. The independent structural stop remains the safety
  mechanism in replay.

The variant intentionally does not change entry, sizing, leverage, structural stop, take-profit,
trailing, runtime defaults, PM2 state, journals, or authorization. No ADA/SUI-specific values
were introduced.

## Causal Comparison

`compareMicroBurstOfflineExitPolicies()` replays the same ordered observations through CURRENT
and the variant. It forces the effective CURRENT marker to `MICRO`, preserves executable exit
quotes and residual costs, and never uses future observations. If either trajectory has no
complete executable exit or the input horizon ends while it is open, the comparison is marked
incomplete. An open position is never treated as zero, a winner, or a completed loss.

The current repository does not contain a complete full-context replay dataset for a validated
economic comparison. This change therefore delivers the reducer, comparison contract, tests,
and evidence rules; it does not claim an economic advantage.

## Decisions Before LIVE

- Decide whether the six-minute absolute exposure limit is acceptable for any future live policy.
- Supply a complete event-time dataset with executable quantity-covered quotes, fees, spread,
  slippage, funding where applicable, protection state, and sufficient post-entry horizon.
- Run paired CURRENT/variant replay and review net PnL, drawdown, duration, returned favorable
  excursion, exit reasons, and incomplete/ambiguous cases.
- Obtain explicit LIVE approval before adding any runtime policy marker or consumer.
