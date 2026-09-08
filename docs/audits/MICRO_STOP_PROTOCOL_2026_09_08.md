# Micro Stop Protocol

## Source And Exchange Evidence

Resumed from clean source `d7e639b3d786c2b9637d344f2643c560e3416d62`.
Read-only PM2 metadata still identified `01-Trading-Bot` PID 627698, and
`02-Aegis-API` stopped. This is not a deployed-artifact attestation.

On 2026-09-08 the Binance developer documentation URL redirected to the new
catalog, then returned HTTP 202 with `x-amzn-waf-action: challenge` and an empty
body. An empty webfetch result was not treated as documentation evidence.

The official Binance JavaScript connector was accessible. Its trade API source
at commit `47690a979c13170ab18d08b127e1a92ee01d420a` documents:

- `POST /fapi/v1/algoOrder` for conditional `STOP_MARKET` orders.
- Quantity and `reduceOnly` cannot accompany `closePosition=true`.
- `reduceOnly` cannot be sent in hedge mode.
- The regular modify-order endpoint supports LIMIT modification, not an atomic
  conditional STOP_MARKET amendment. No algo-modify endpoint is established here.

Reference: https://github.com/binance/binance-connector-js/blob/47690a979c13170ab18d08b127e1a92ee01d420a/clients/derivatives-trading-usds-futures/src/rest-api/modules/trade-api.ts

This establishes documented request semantics, NOT actual acceptance of overlapping
reduce-only protection on this account. No real test order, cancellation, leverage
change or margin change was sent. The connector is generated first-party API
documentation, not proof of execution or economic results.

## Implemented Contract

New adjustments use an identified full-quantity, one-way reduce-only stop, with
`closePosition` omitted from the transport. Quantity is bound to the durable
request and freshly checked before sending and after exact stop observation.
The adapter rejects invalid quantities, hedge scope and incompatible flags before
transport. Stop queries require exact quantity, scope, trigger, flags and identity;
triggered-stop attribution additionally requires the exact complete child order.
New trigger prices are rounded toward tighter protection using exchange tick and
precision filters before deriving the durable adjustment key.

The existing covering stop remains in place. A rejected or unknown replacement
does not cancel it, advance the local stop price, or permit another submission.
Restart observes the same operation. Historical close-all adjustment requests are
read using their original fields, never rewritten or resent as quantity orders.
The historical journal protocol and hashes are not renamed or recomputed.

The previous stop is deliberately retained even after the new stop is confirmed;
this increment does not introduce cancellation while a position remains open.
Existing flat-position cleanup remains responsible for retirement. Order limits or
exchange reduce-only conflicts may therefore reject subsequent adjustments, and
the pending identity remains blocked. This is not a completed cancel/replace state
machine, nor a guarantee that quantity stops will coexist on the exchange.

## Verification And Boundary

The targeted Micro/shared-safety suite passed 939 tests in 60 files, with
`AEGIS_ENABLED=false`. It includes simulated rejection of duplicate close-all
stops, quantity adjustment persistence, ambiguous/rejected adjustment recovery,
hedge/changed-position denial and original-contract historical observation. Adapter
tests separately inspect signed transport parameters, exact quantity and child
attribution, and no retry after simulated -4130, -4509 or -2022 responses.
Offline fixtures are explicitly not exchange acceptance evidence.

Five selected source-integrity tests also passed (15 unrelated tests skipped).
External compilation passed at `/tmp/opencode/micro-stop-protocol-20260908-build`.
An earlier compile caught a missing leverage argument in the new filter lookup;
the corrected path requires known positive leverage instead of inventing a default.
The affected flow, durable-stop and protection suites then passed again: 65 tests
in three files, overlapping the 939-test run rather than adding to that count.
Whitespace validation passed. No whole-repository or Aegis-suite success is claimed.

Source checkpoints for the reviewed Exchange port and Binance adapter are changed
only as source-integrity checkpoints, not config approval or deployment signatures.
No operational YAML, environment, dist, operator keys, ledger or journals changed.
ADA's local state remains IDLE with both ambiguous-entry and unverified-PnL flags.
Its missing policy/episode provenance has not been invented or adopted.

The full operator task is still incomplete: canonical non-versioned Micro identity
and single-policy migration, full bootstrap/feed integration, active-position stop
retirement/fallback, exact historical ADA accounting recovery, artifact/config
approval, deployment and monitored runtime attestation remain outstanding. This
source increment must not be used as a claim that those blockers are resolved.
