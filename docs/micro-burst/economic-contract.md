# Micro Economic Contract

Status: Phase 2 research contract. This module does not change the LIVE policy,
entry admission, sizing, leverage, PM2, state, or journals.

Implementation: `src/strategies/micro-burst/domain/MicroBurstEconomicContract.ts`.
The current order-book exit adapter delegates full-depth VWAP resolution to the
same pure resolver. The research outcome engine and offline comparator use the
same signed-return primitive. No new economic rule is connected to execution.

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

- Directed economic/research tests: `70/70` passed.
- Full serial command: `npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism`.
- Full serial result: exit code `1`; `228/229` files passed; `3042/3044` tests
  passed. The only failures are the two pre-existing `TradingService.ts` digest
  checkpoints documented in `docs/micro-burst-phase0-1.md`.
- `npm run build`: passed.
- `git diff --check`: passed.
