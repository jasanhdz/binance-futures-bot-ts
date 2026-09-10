# Micro Historical Reconciliation

The runtime may reconcile a closed historical Micro entry without assigning it a
current policy, episode or configuration. This read boundary is restricted to the
persisted `0.8.0-expected-continuation-live` entry protocol. It grants no authority
to execute that historical strategy.

## Evidence And Ownership

- The pending entry journal supplies the original trade, client order ID, side,
  quantity, entry price and code/configuration provenance.
- The Binance adapter matches the original entry client ID, discovers bounded
  closing order IDs, then independently verifies exact filled orders, exhaustive
  trade coverage, both fee legs, funding coverage and fresh flat observations.
- Two sequential observations, separated by at least 300 ms, require no position
  on either side and empty unfiltered regular and algo open-order inventories.
  Errors, incomplete responses, foreign orders and stale/backward time fail closed.
- The entry coordinator owns the pending admission reservation. TradingService
  additionally uses its shared entry reservation and runtime shutdown tracking.
  No operator process writes the live journals or projection.

## Durable Sequence

1. The existing stop journal owner appends a separate retirement operation with
   status `RETIRED_AFTER_CONFIRMED_FLAT` and the complete economic/flat proof.
   Original stop mutation bytes remain unchanged. No cancellation is inferred.
2. The net ledger stores the historical identity and verified cashflows through
   the same transaction and fill/funding deduplication indexes as current trades.
   Actual closing fill time determines the UTC accounting day. Importing an old
   loss neither increments today's streak nor releases today's existing pause.
3. The projection persists the historical close proof, rechecks flatness and all
   open orders again, then flushes only the matched trade's ambiguity/accounting
   and protection flags. A failed final flush restores the in-memory quarantine.
4. The entry journal appends `EXTERNALLY_CONFIRMED_CLOSE` evidence through its
   normal close transitions and flushes before releasing admission. Restart
   validates the terminal proof and never resends the retired stop or reconstructs
   that historical position.

Binance `-2013` alone is insufficient. Empty open-order inventories establish
absence at observation time, not that an unknown stop was historically canceled
or never existed. Account reads are sequential, not an atomic Binance transaction;
external account writers cannot be excluded by the bot's local reservations.

## Market Data And Operator Clock

When REST depth arrives before the first useful websocket diff, the order book
now retains the snapshot and waits for its bridge. It no longer requests another
REST snapshot on each diff while waiting. Missing bridges and stale observations
still block readiness; freshness thresholds are unchanged.

USD-M bootstrap drops only events with `u < lastUpdateId` and consumes the first
bridge satisfying `U <= lastUpdateId <= u`, including `u == lastUpdateId`.
After that bridge, nonduplicate events must chain `pu` to the previous `u`.
The same boundary applies to buffered events and events arriving after REST.
Reference: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly

The local initialization CLI awaits a validated Binance UTC clock before creating
keys or storage and signs with that clock. Tests inject offline time. This command
must not be used to reset or reinitialize an existing production ledger.

## Boundary Follow-Up Validation

On 2026-09-10 the final scoped runs passed 1,663 tests in 96 files. Initial
fork-pool runs reported an unhandled Vitest RPC timeout despite passing assertions;
they are not counted as successful validation. The final selection uses threads,
except the registry suite which requires `process.chdir()` and therefore forks.
These are offline tests; no Aegis application is started.

```bash
AEGIS_ENABLED=false npx vitest run src/strategies/micro-burst src/app/execution src/app/position src/app/bootstrap src/core/market-data src/core/risk src/infra/state src/tooling/micro-burst src/infra/adapters/BinanceAdapter.settlement.test.ts src/app/services/TradingService.safety-contracts.test.ts src/restoration --exclude src/infra/state/StrategyLossStateRegistry.test.ts --silent --maxWorkers=2 --pool=threads --reporter=dot
AEGIS_ENABLED=false npx vitest run src/infra/state/StrategyLossStateRegistry.test.ts --silent --maxWorkers=1 --pool=forks --reporter=dot
```

TypeScript compiled into `/tmp/opencode/micro-usdm-boundary-dist`, outside the
running artifact. Deployment and runtime observations are recorded separately in
`logs/micro-historical-20260910/`; local tests do not establish live readiness.
