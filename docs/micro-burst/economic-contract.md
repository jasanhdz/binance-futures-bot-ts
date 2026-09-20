# Micro Economic Contract

Status: Phase 2 research contract. This module does not change the LIVE policy,
entry admission, sizing, leverage, PM2, state, or journals.

Implementation: `src/strategies/micro-burst/domain/MicroBurstEconomicContract.ts`.
The current order-book exit adapter delegates full-depth VWAP resolution to the
same pure resolver. The research outcome engine and offline comparator use the
same signed-return primitive. No new economic rule is connected to execution.

## Consumers And Deployment Boundary

| Component | Published consumer | LIVE runtime? | Research-only? |
| --- | --- | --- | --- |
| `MicroBurstEconomicContract` | Its full calculator is currently consumed by its tests; `resolveMicroBurstExecutablePrice` is consumed by `MicroBurstExecutableExitEconomics` | The full calculator is not on LIVE; the resolver is indirectly on the LIVE exit-context path | The full calculator is research/validation code |
| `MicroBurstExecutableExitEconomics` | `TradingService.ts:2801-2885` | Yes, when the existing Micro exit-context path runs; it only supplies executable quote economics to the existing policy | No |
| `MicroBurstOutcomeEngine` | `MicroBurstRuntime.ts:837-883`, `MicroBurstOutcomeTracker`, `MicroBurstProspectiveAnalyzer` | Imported by the runtime for prospective/shadow outcome tracking, not for entry admission or LIVE exit decisions | Its simulations and outcome analysis are research |
| `MicroBurstOfflineExitComparison` | No production import; direct test/research use only | No | Yes |

The source branch is published at `c814b1a`. PM2's current identity remains
`GIT_COMMIT_SHA=88199bcbeffe0008d2a8e1070cf0fa6aa9aedd9e` and
`MICRO_BURST_APPROVED_COMMIT` matches that value. Therefore the phase-2 source is
not the deployed/approved reference. No deployment was performed here.

## Units And Signs

- Prices are positive quote-currency prices.
- Quantity is the base-asset quantity.
- PnL, commissions, funding, and risk are USDT.
- Basis points use `10_000` per unit return.
- Funding is signed account cash flow: positive funding increases net PnL;
  negative funding decreases it.
- Commission amounts are positive costs and are subtracted from net PnL.
- LONG profit is `(exit - entry) * quantity`.
- SHORT profit is `(entry - exit) * quantity`.

## Inputs And Provenance

Every economic input is an `EconomicDatum<T>` containing:

- value;
- source identifier;
- event/observation timestamp;
- optional receive timestamp;
- quality: `ACTUAL`, `ESTIMATED`, or `DERIVED`.

The contract also carries quantity separately for entry and exit, the maximum
acceptable age, whether a price already includes slippage, and structural/favorable
price provenance. An available result explicitly reports `quantityCovered=true` and
retains depth/slippage provenance when supplied. Missing, future, stale, invalid, or uncovered inputs return
`UNAVAILABLE` with a reason and field list. No missing fee or funding is replaced by
zero.

## Execution Price

For a complete exit book, the resolver consumes the bid levels for LONG liquidation
and ask levels for SHORT liquidation:

`executablePrice = sum(fillQuantity_i * levelPrice_i) / requestedQuantity`

The result is available only when all requested quantity is covered, prices and
quantities are valid, levels are correctly ordered, and the book is fresh. A direct
price may be used when it is already an executable/VWAP observation.

If `priceIncludesSlippage=true`, no slippage adjustment is applied. Otherwise the
adverse adjustment is applied exactly once:

- LONG entry: price increases; LONG exit: price decreases.
- SHORT entry: price decreases; SHORT exit: price increases.

The reported `slippageUsdt` is diagnostic. It is already reflected in effective
prices and is never subtracted a second time from PnL.

If a price does not include slippage, its slippage datum is mandatory. The contract
does not silently use zero.

## PnL And Costs

With effective entry/exit prices:

`grossPnl = signedPriceDifference * quantity`

`netPnl = grossPnl - entryCommission - exitCommission + funding`

Commission quality distinguishes actual settlement charges from estimated current
exit charges. Funding must be explicitly known, including an explicit known zero.
The same funding datum and each commission datum enter the formula once.

The five local Binance-derived settlements reproduce their Phase 0 gross/net values
in `MicroBurstEconomicContract.test.ts`. These are local evidence exports, not
current exchange queries.

## Incremental Economics

Total operation net PnL includes entry commission and known funding. Incremental
close/hold analysis does not turn an already-paid entry commission into a required
future recovery target. The current contract exposes:

- `netPnlUsdt`: total operation result, including entry commission, exit commission,
  and known funding;
- `incremental.closeNowNetUsdt`: close-now cost from the current executable
  liquidation baseline, excluding sunk entry costs;
- `riskToInvalidationUsdt`: gross adverse price distance from the current executable
  exit to the structural invalidation, floored at zero;
- `favorablePathGrossUsdt`: geometric distance from the current executable exit to
  the favorable obstacle, floored at zero;
- `favorablePathNetUsdt`: that path less the exit commission assumption only.

These are incremental price-path quantities. They do not include sunk entry fees,
and they do not imply that the obstacle will be reached or filled.

## Break-Even

With fixed known/estimated USDT charges:

`fixedCosts = entryCommission + exitCommission - funding`

- LONG: `breakEvenExit = effectiveEntry + fixedCosts / quantity`.
- SHORT: `breakEvenExit = effectiveEntry - fixedCosts / quantity`.

Break-even is an estimated price under the supplied assumptions. It is not a target,
expected value, success probability, or execution guarantee.

## Existing Calculation Differences

- `MicroBurstExecutableExitEconomics` previously owned full-depth VWAP and freshness
  checks. It now delegates only that resolution to the shared pure resolver; its
  existing LIVE-facing validation and returned shape remain unchanged.
- `MicroBurstOutcomeEngine` retains its historical scenario analysis and fixed
  `costBps` outputs. It now shares side-aware return math, but its scenarios are not
  settlement evidence and are not silently converted into actual fees.
- `MicroBurstOfflineExitComparison` retains its quote-mark-only output and
  `economicEvidenceEligible=false`. It uses the shared signed return but does not
  claim fills, fee settlement, stop acknowledgements, or alternative execution.
- Entry structural geometry still reports bps and reward/risk from the existing
  policy. This phase does not connect monetary economics to entry admission or alter
  sizing, leverage, filters, `EARLY_FAILURE`, or `MAX_HOLD`.

## Compatibility Replay

The reproducible prior reference is parent commit `d2630a4`. Running
`scripts/micro-burst-phase01-audit.ts` against the same local journals, logs, and
embedded policy snapshots from both references produced byte-identical JSON output
(`diff` was empty): the same recorded action, reason, and requested stop for all
audited observations. This includes the five phase-0 trades; it is replay evidence,
not a fixture presented as historical execution.

The prior/current directed baseline comparison also passed the existing executable
VWAP and outcome-engine cases with the same valid LONG/SHORT results. The current
contract adds 14 economic tests and the adapter adds two empty-depth cases.

The only direct boundary change is defensive: an empty depth array now returns
`null` from `MicroBurstExecutableExitEconomics` instead of dereferencing index zero
and throwing. In the LIVE caller this remains inside the existing `try/catch`, so the
result is the same unavailable economics path and no exit action/motive/stop move
changes. This is an intentional non-decision robustness change, not an economic
policy change.

## Compatibility Details

- Real settlement commissions are fill-level USDT charges. Runtime exit costs are
  supplied by the existing `readMicroBurstExitCosts` adapter as a residual bps input;
  the shared full calculator is not substituted into that LIVE call.
- Historical funding is accumulated only from attributed settlement evidence. Future
  funding is unknown and cannot be represented as a known zero.
- The runtime adapter requires current position quantity to equal the stored entry
  quantity. The shared contract likewise requires entry/exit quantities to match;
  partial closure is unavailable rather than silently re-priced.
- Full depth must cover the requested quantity. Insufficient depth is unavailable;
  no last-trade or top-level fallback is introduced.
- Internal calculations use JavaScript numbers without forced exchange tick rounding.
  `roundEconomicAmount` is explicit and opt-in; settlement reconciliation retains
  fill-derived precision and uses a tolerance for binary representation.
- Book observations use exchange/event timestamps for freshness; `Date.now()` is the
  caller's local evaluation clock. Receive timestamps are provenance only and are not
  substituted for event timestamps.
- A VWAP/depth price marked `priceIncludesSlippage=true` is not charged slippage
  again. If it does not include slippage, the slippage datum is mandatory.
- Total net PnL includes entry commission and known funding. Incremental close/hold
  fields exclude sunk entry costs and do not create a recovery obligation.
- Break-even is conditional on the supplied fixed commission/funding/slippage
  assumptions. It is not a guaranteed executable price, target, expected value, or
  success probability.

Settlement attribution remains fill-based: `MicroBurstSettlement.ts:159-222`
checks operation symbol, entry/close order IDs, unique fill IDs, side, time window,
quantity, USDT commissions, funding trade ID/symbol/time, and then computes
`gross - commissions + funding`. The phase-0 read-only script additionally records
each order/fill identity before comparing the stored net result. It does not rebuild
the net by passing the final net as an input.

## Limits

- No probability model, expected return, or fill probability is produced.
- A structural obstacle is a geometric reference, not expected profit.
- A complete top-of-book depth snapshot is not a continuous execution simulator.
- Stop movement, acknowledgement, trigger timing, queue position, partial fills,
  funding interval selection, and post-close management require separate evidence or
  simulation.
- Historical settlement reconciliation remains dependent on the local ledger's
  exact Binance-derived evidence and does not authorize a live data refresh.

## Validation

- Directed economic/research tests: `72/72` passed.
- Full serial command: `npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism`.
- Full serial result: exit code `1`; `228/229` files passed; `3044/3046` tests
  passed. The only failures are the two pre-existing `TradingService.ts` digest
  checkpoints documented in `docs/micro-burst-phase0-1.md`.
- `npm run build`: passed.
- `git diff --check`: passed.
