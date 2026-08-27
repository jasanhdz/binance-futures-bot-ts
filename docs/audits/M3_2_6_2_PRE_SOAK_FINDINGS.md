# M3.2.6.2 Pre-Soak Findings

Base SHA: `ee5aa5cc225c26a991a884869f19dc89243bfae7`

Implementation SHA: `19b7df9ff3994883f89aca999e6e8bc723513a50`

Exact CI: run `33127120902`, status `completed`, conclusion `success`.

## Scope

Audit of the current Micro Burst implementation before the final 900-second SHADOW soak. The audit was performed against the dirty worktree after the M3.2.6.1 closure commits. No exchange mutation, official cohort, or soak was started.

## Findings

### FINDING: P0-1 Binance snapshot bridge boundary

- SEVERITY: P0
- STATUS: CONFIRMED FIXED
- FILES: `src/domain/strategies/micro-burst/SynchronizedOrderBook.ts`, `src/domain/strategies/micro-burst/SynchronizedOrderBook.test.ts`
- CURRENT BEHAVIOR: Bootstrap retains events with `u >= lastUpdateId`, accepts the bridge when `U <= lastUpdateId <= u`, skips reapplying a boundary event whose `u` equals the snapshot ID, and enforces `pu` continuity for later events.
- IMPACT: Prevents stale buffered events from being applied while preserving the documented milestone boundary case.
- FIX: Boundary and no-duplicate tests are present. The Binance documentation endpoint was protected by an AWS WAF challenge in this environment; the repository's USD-M reference algorithm and current tests use the `u < lastUpdateId` discard rule.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P0-2 typed gaps are not used by outcomes

- SEVERITY: P0
- STATUS: CONFIRMED FIXED
- FILES: `src/app/micro-burst/MicroBurstFeedDependencies.ts`, `src/app/micro-burst/MicroBurstOutcomeTracker.ts`, `src/app/micro-burst/MicroBurstStorage.ts`, `src/tooling/micro-burst/MicroBurstProspectiveAnalyzer.ts`
- CURRENT BEHAVIOR: SIGNAL_PRICE maturity queries only its declared `AGG_TRADE` dependency. Depth, mark-price, and unknown legacy gaps are not silently treated as trade gaps. Official analysis blocks required-feed and `UNKNOWN_LEGACY` gaps.
- IMPACT: Prevents unrelated market-data outages from selectively invalidating or pooling outcomes.
- FIX: Feed-aware gap queries and explicit conservative unknown-legacy handling are wired into outcome maturity, analyzer gates, and readiness.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P0-3 mixed clock subtraction

- SEVERITY: P0
- STATUS: CONFIRMED FIXED
- FILES: `src/domain/strategies/micro-burst/MicroBurstContextBuilder.ts`, `src/domain/strategies/micro-burst/SynchronizedOrderBook.ts`, `src/domain/strategies/micro-burst/BtcMicroContextProvider.ts`, `src/domain/strategies/micro-burst/MicroBurstClocks.ts`
- CURRENT BEHAVIOR: Candle and signal causality use exchange/event time. Book, BTC, and liquidity transport freshness use local receive time and local `now`. Negative ages are stale or otherwise fail closed rather than silently becoming fresh.
- IMPACT: Local/server clock offsets cannot change a valid market state into an invalid or falsely fresh state.
- FIX: Added same-domain receive timestamps and tests for offset scenarios.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P0-4 AggTrade completeness implied or lost on restart

- SEVERITY: P0
- STATUS: CONFIRMED FIXED
- FILES: `src/domain/strategies/micro-burst/MicroBurstAggTradeBuffer.ts`, `src/domain/strategies/micro-burst/MicroBurstRuntime.ts`, `src/domain/strategies/micro-burst/MicroBurstContextBuilder.ts`
- CURRENT BEHAVIOR: Completeness requires causal event-time coverage, `windowComplete`, no capacity truncation, and no detected trade-ID gap. A detected aggregate-trade sequence gap is now persisted as a typed `AGG_TRADE` gap when storage is available.
- IMPACT: Warmup, emergency-cap truncation, and sequence loss cannot produce valid taker-flow context or be forgotten across a runtime restart.
- FIX: Added causal coverage fields, data-quality invalid reasons, and runtime persistence of sequence-gap intervals.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P0-5 runtime readiness does not verify AggTrade condition

- SEVERITY: P0
- STATUS: CONFIRMED FIXED
- FILES: `src/domain/strategies/micro-burst/MicroBurstRuntime.ts`, `src/domain/strategies/micro-burst/MicroBurstReadiness.ts`
- CURRENT BEHAVIOR: Readiness checks every enabled runtime symbol for healthy books and complete, gap-free, non-truncated AggTrade windows and reports symbol blockers.
- IMPACT: A partially warmed or impaired symbol cannot be represented as globally healthy.
- FIX: Readiness consumes per-symbol flow state and retains separate soak, freeze, and authority states.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P1-1 liquidity freshness consumed as scalar only

- SEVERITY: P1
- STATUS: CONFIRMED FIXED
- FILES: `src/app/services/LiquidityVoidDetector.ts`, `src/app/services/TradingService.ts`, `src/domain/services/AegisMicroLiveGate.ts`, `src/domain/strategies/momentum-ride/MomentumRideEntryPolicy.ts`
- CURRENT BEHAVIOR: Consumers receive `FRESH`, `STALE`, or `NO_DATA`, age, stress, and `DEPTH20_PARTIAL_V1`. Stale or missing data follows the existing conservative gate behavior.
- IMPACT: Old stress values cannot be treated as current liquidity evidence.
- FIX: Replaced scalar-only runtime consumption and added diagnostics/tests.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P1-2 ambiguous fill fallback too broad

- SEVERITY: P1
- STATUS: CONFIRMED AND HARDENED
- FILES: `src/app/execution/SharedStrategyExecutionService.ts`, `src/app/ports/Exchange.ts`, `src/infra/adapters/BinanceAdapter.ts`
- CURRENT BEHAVIOR: Reconciliation accepts exact client-order lookup or explicit exchange evidence. It no longer treats the first same-side fill or any existing position as proof of this submission.
- IMPACT: Manual, unrelated bot, and pre-existing same-side exposure cannot be misattributed to a timed-out order.
- FIX: Removed broad fill/position fallbacks. Unlinked ambiguity remains `MARKET_OPEN_AMBIGUOUS` and blocks the symbol.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P1-3 bracket ownership

- SEVERITY: P1
- STATUS: RESIDUAL PROTOCOL LIMITATION
- FILES: `src/app/execution/SharedStrategyExecutionService.ts`, `src/app/ports/Exchange.ts`
- CURRENT BEHAVIOR: Bracket verification checks type, trigger, side, position side, working type, close/reduce semantics, and exact price. The close-order port does not carry a deterministic client-order ID or owner field.
- IMPACT: A stale identical manual bracket could theoretically satisfy structural verification.
- FIX: No speculative ownership field was added. This remains a documented testnet/LIVE protection-verification limitation, not a SHADOW data-integrity blocker.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P1-4 realized close PnL

- SEVERITY: P1
- STATUS: CONFIRMED FIXED
- FILES: `src/app/execution/SharedStrategyExecutionService.ts`, `src/app/micro-burst/MicroBurstOutcomeTracker.ts`
- CURRENT BEHAVIOR: Exact fills and realized PnL are preferred. Missing exact evidence remains unknown and is not converted into a mark-derived win.
- IMPACT: Risk accounting does not fabricate profitable close outcomes.
- FIX: Existing lifecycle reconciliation retained and covered by tests.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P1-5 cohort omitted from analyzer grouping

- SEVERITY: P1
- STATUS: CONFIRMED AND FIXED
- FILES: `src/tooling/micro-burst/MicroBurstProspectiveAnalyzer.ts`
- CURRENT BEHAVIOR: Compatible groups include strategy version, config hash, code SHA, cohort ID, side, and entry model.
- IMPACT: Non-official/debug analysis cannot accidentally pool rows from different cohorts.
- FIX: Added `cohortId` to the internal grouping key and report diagnostics.
- SEMANTIC STRATEGY CHANGE: NO

### FINDING: P1-6 readiness confuses correctness and official authority

- SEVERITY: P1
- STATUS: CONFIRMED AND FIXED
- FILES: `src/domain/strategies/micro-burst/MicroBurstReadiness.ts`, `src/domain/strategies/micro-burst/MicroBurstRuntime.ts`
- CURRENT BEHAVIOR: `readyForSoak`, `readyForFreeze`, and `officialAuthority` are separate. Soak correctness does not require official cohort assertion, and no readiness result grants LIVE authority.
- IMPACT: An isolated SHADOW soak can be assessed without silently starting M3.3.
- FIX: Added explicit readiness fields while retaining `official=false` and `liveAuthority=false`.
- SEMANTIC STRATEGY CHANGE: NO

## Dependency Security

Fresh `npm audit --omit=dev` reports 6 runtime vulnerabilities: 5 high and 1 moderate.

- `axios`: direct runtime dependency, high, patched updates available; requires compatibility review.
- `js-yaml`: direct runtime dependency, high, patched updates available; configuration parser compatibility review required.
- `form-data`: transitive runtime dependency, high, patched updates available through HTTP dependency chain.
- `adm-zip`: transitive through `onnxruntime-node`, high; exchange path reachability requires deployment-specific review.
- `follow-redirects`: transitive through `axios`, moderate.

No automatic dependency update was applied. `npm audit fix --force` was not run. These advisories remain formally open until dependency versions and deployed reachability are reviewed.

## Verification State

- Full Vitest: 106 files, 1,163 tests passed.
- TypeScript build: passed.
- `git diff --check`: passed.
- Pre-cohort audit: blocked because this command intentionally has no fresh runtime/archive evidence.
- Final soak: not run.
- Official cohort: not started.
