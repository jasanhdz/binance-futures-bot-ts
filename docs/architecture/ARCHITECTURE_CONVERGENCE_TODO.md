# Final Architecture Convergence TODO

Status: IN_PROGRESS

## P0 — namespace and ownership convergence

- [ ] Remove pure migration facades under `src/domain/strategy`, `src/domain/strategies`, `src/domain/risk`, `src/strategies/strategy`, `src/strategies/types.ts`, `src/domain/types.ts` and remaining Micro Burst compatibility facades.
- [ ] Remove `src/app/micro-burst` as a strategy namespace.
- [ ] Move Micro Burst runtime orchestration from `domain` to `application`.
- [ ] Move Micro Burst outcome tracking/storage/tests to `research`.
- [ ] Remove `src/app/strategy/MicroBurstPositionManager.ts` facade.
- [ ] Converge Aegis domain services from `src/domain/services/Aegis*` and `aegis-entry/` into `src/strategies/aegis/domain`.
- [ ] Remove the duplicate legacy `src/domain/services/AegisStrategy.ts` copy.
- [ ] Normalize Momentum legacy imports to `src/strategies/momentum/domain`.

## P1 — boundaries and generic ownership

- [ ] Re-audit Micro Burst wrappers around shared market data (`SynchronizedOrderBook`, benchmark/BTC derivation) for true strategy-specific semantics.
- [ ] Audit `MicroBurstStorage` after relocation and split generic persistence/archive primitives only where behavior-preserving extraction is clear.
- [ ] Verify no shared/core/app module imports a legacy strategy facade.
- [ ] Verify no generic market-data implementation is strategy-owned.

## P2 — quality gates

- [ ] `git diff --check`
- [ ] TypeScript build
- [ ] Full unit/integration suite
- [ ] Architecture/restoration contracts
- [ ] Search for forbidden legacy namespaces
- [ ] Official branch CI green on final SHA
- [ ] Mark `ARCHITECTURE_CONVERGENCE_FINAL = COMPLETE`

No economic logic, thresholds, LIVE authority, order mutation, or strategy behavior may change in this cleanup.
