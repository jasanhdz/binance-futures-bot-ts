# Final Architecture Convergence

Status: COMPLETE

`ARCHITECTURE_CONVERGENCE_FINAL = COMPLETE`

## P0 — namespace and ownership convergence

- [x] Removed pure migration facades under `src/domain/strategy`, `src/domain/strategies`, `src/domain/risk`, `src/strategies/strategy`, `src/strategies/types.ts`, `src/domain/types.ts` and the remaining Micro Burst compatibility facades.
- [x] Removed `src/app/micro-burst` as a strategy namespace.
- [x] Moved Micro Burst runtime orchestration from `domain` to `src/strategies/micro-burst/application`.
- [x] Moved Micro Burst outcome tracking/storage/tests to `src/strategies/micro-burst/research`.
- [x] Removed the `src/app/strategy/MicroBurstPositionManager.ts` facade.
- [x] Converged Aegis domain services from `src/domain/services/Aegis*` and `aegis-entry/` into `src/strategies/aegis/domain`.
- [x] Removed the duplicate legacy `src/domain/services/AegisStrategy.ts` copy.
- [x] Normalized Momentum legacy imports to `src/strategies/momentum/domain`.

## P1 — boundaries and generic ownership

- [x] Re-audited Micro Burst wrappers around shared market data. The strategy-owned `SynchronizedOrderBook` compatibility wrapper was removed; runtime now consumes the canonical shared implementation from `src/core/market-data`. The old behavior tests moved with the shared owner.
- [x] Re-audited benchmark/BTC context. Market acquisition remains generic through `BenchmarkMarketData`; Micro Burst keeps only its strategy-specific causal return/direction/conflict semantics because replacing them with the current neutral feature implementation is not guaranteed to be behavior-equivalent.
- [x] Audited `MicroBurstStorage` after relocation. It remains under `research` because its schema, reconciliation, prospective outcomes and archive semantics are Micro Burst research responsibilities. Generic persistence primitives should only be extracted when a second consumer demonstrates a stable shared contract; premature generalization was intentionally avoided.
- [x] Verified shared/core/app boundaries no longer depend on legacy strategy facade namespaces. `MLService` now keeps Aegis diagnostics opaque at the shared application port instead of importing the concrete Aegis strategy type.
- [x] Verified generic market-data ownership: clocks, normalized events, depth continuity, synchronized order book, rolling AggTrades and neutral snapshot/capability components remain under `src/core/market-data`.

## P2 — quality gates

- [x] `git diff --check`
- [x] TypeScript build
- [x] Full unit/integration suite
- [x] Architecture/restoration contracts updated to canonical ownership paths and passing
- [x] Forbidden legacy namespace audit
- [x] Temporary convergence workflows/scripts removed
- [x] Official `Micro Burst Architecture CI` green on the converged branch
- [x] Marked `ARCHITECTURE_CONVERGENCE_FINAL = COMPLETE`

## Canonical strategy ownership after convergence

```text
src/strategies/
  aegis/
  momentum/
  micro-burst/
    application/
    domain/
    research/

src/core/
  market-data/
  risk/
  shadow/
  strategy/
```

`src/app` remains application-wide orchestration/capabilities rather than a second strategy namespace.

No economic logic, thresholds, LIVE authority, order mutation, or intended strategy behavior changed in this cleanup.
