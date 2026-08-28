# M3.2.6.3 Pre-Soak Findings

Repository: `jasanhdz/binance-futures-bot-ts`
Branch: `work/micro-burst-rider-v1-20260826`
Audited HEAD: `c0b9ec908603d59d570abd4965bec33331a7e53d`

## P0-1

FINDING: AggTrade gap state is currently sticky forever.
SEVERITY: P0
STATUS: CONFIRMED
FILES: `src/domain/strategies/micro-burst/MicroBurstAggTradeBuffer.ts:25-65,129-138`
CURRENT BEHAVIOR: A sequence discontinuity sets `gapFree=false`; the value is only restored by `clear()`. Gap intervals are not retained or evaluated against the requested event-time window.
WHY IT MATTERS: A historical reconnect gap can permanently invalidate future windows after it no longer overlaps the requested causal horizon.
PROPOSED FIX: Replace the lifetime boolean with bounded, event-time gap intervals and calculate `gapFree` from intervals overlapping the requested window. Prune only beyond the largest supported retained horizon.
STRATEGY SEMANTICS CHANGED: NO

## P0-2

FINDING: AggTrade gap callback is not wired into production runtime.
SEVERITY: P0
STATUS: CONFIRMED
FILES: `src/domain/strategies/micro-burst/MicroBurstRuntime.ts:126-140,272-309`
CURRENT BEHAVIOR: `MicroBurstAggTradeBuffer` accepts `onGap`, but runtime constructs it without a callback. `marketStorage.recordGap` is therefore never called for detected AggTrade sequence gaps.
WHY IT MATTERS: In-memory gap evidence disappears on restart and cannot support authoritative prospective analysis.
PROPOSED FIX: Wire a typed callback that persists an `AGG_TRADE` gap with conservative event-time bounds and deterministic deduplication.
STRATEGY SEMANTICS CHANGED: NO

## P0-3

FINDING: Restored persisted AggTrade gaps do not affect runtime window completeness.
SEVERITY: P0
STATUS: CONFIRMED
FILES: `src/domain/strategies/micro-burst/MicroBurstRuntime.ts:650-666`, `src/app/micro-burst/MicroBurstStorage.ts:691-709`
CURRENT BEHAVIOR: Runtime readiness reads only the in-memory buffer. Storage exposes `hasGapForFeed`, but runtime does not query or restore relevant persisted gaps.
WHY IT MATTERS: A restart can report a complete current window despite a persisted overlapping AggTrade gap.
PROPOSED FIX: Inject a bounded feed-aware gap query into the buffer/runtime flow and fail closed on query failure.
STRATEGY SEMANTICS CHANGED: NO

## P0-4

FINDING: BTC causal candle selection mixes local and exchange clocks.
SEVERITY: P0
STATUS: CONFIRMED
FILES: `src/domain/strategies/micro-burst/BtcMicroContextProvider.ts:89-114,163-165`
CURRENT BEHAVIOR: `clock.now()` is passed to `computeReturns`, where exchange candle `closeTime` is compared against local time. Receive freshness also uses the local clock, correctly but without separating the causal snapshot time.
WHY IT MATTERS: Local clock skew can change which candle is considered closed and alter causal BTC features.
PROPOSED FIX: Carry exchange snapshot time separately for candle eligibility and retain local receive time solely for transport freshness.
STRATEGY SEMANTICS CHANGED: NO

## P0-5

FINDING: Existing smoke test does not exercise the production WebSocket path.
SEVERITY: P0
STATUS: CONFIRMED
FILES: `scripts/micro-burst-shadow-smoke.ts:28-33,111-123`
CURRENT BEHAVIOR: The script directly uses `binance-api-node` futures WebSocket APIs and reports an M2 operational verdict. Production uses `BinanceExchange -> WebSocketManager -> MarketDataHub -> direct ws`.
WHY IT MATTERS: A passing legacy diagnostic cannot prove production parser, routing, receive timestamp, reconnect, or lifecycle behavior.
PROPOSED FIX: Add a separate production-path smoke script using the same `BinanceExchange`/`WebSocketManager`/`MarketDataHub` composition and require both symbols to receive both streams.
STRATEGY SEMANTICS CHANGED: NO

## P0-6

FINDING: AggTrade production routing requires current Binance contract verification.
SEVERITY: P0
STATUS: PARTIALLY CONFIRMED
FILES: `src/infra/adapters/MarketDataEndpoints.ts:14-29`, `src/infra/adapters/WebSocketManager.ts:74-135`
CURRENT BEHAVIOR: Code routes depth through `PUBLIC` and AggTrade through `MARKET`, generating `/public/ws/<stream>` and `/market/ws/<stream>`. The official Binance documentation pages were requested during audit but returned no content in this environment, so live documentation confirmation is unavailable.
WHY IT MATTERS: A route contract change could make the production smoke invalid or silently disconnect a feed.
PROPOSED FIX: Preserve the current route separation, add URL tests, and record official documentation evidence when the documentation endpoint is accessible before the smoke gate.
STRATEGY SEMANTICS CHANGED: NO

## P0-7

FINDING: `readyForSoak` is not satisfiable by a real launcher.
SEVERITY: P0
STATUS: CONFIRMED
FILES: `scripts/micro-burst-pre-cohort-audit.ts:17-29`, `src/domain/strategies/micro-burst/MicroBurstRuntime.ts:627-717`
CURRENT BEHAVIOR: The only pre-cohort audit intentionally passes runtime evidence as unavailable. No dedicated launcher creates a fresh run root, manifest, storage, runtime qualification, and result evidence.
WHY IT MATTERS: The required qualification path cannot prove readiness or exact isolated-run provenance.
PROPOSED FIX: Create a SHADOW-only final qualification launcher that validates exact SHA, creates an atomic immutable manifest, starts production runtime, waits for readiness, and writes separate result evidence.
STRATEGY SEMANTICS CHANGED: NO

## P0-8

FINDING: Existing report provenance is stale relative to current HEAD.
SEVERITY: P0
STATUS: CONFIRMED
FILES: `docs/strategies/micro-burst/M3_2_6_2_FINAL_PRE_SOAK_CLOSURE_REPORT.md`, current HEAD `c0b9ec908603d59d570abd4965bec33331a7e53d`
CURRENT BEHAVIOR: The prior report records implementation SHA `19b7df9...`; current candidate HEAD is `c0b9ec9...`, and this milestone will create another implementation SHA.
WHY IT MATTERS: A retained soak could not prove that manifest, tested code, CI, and runtime were identical.
PROPOSED FIX: Write a new M3.2.6.3 report with distinct base SHA, final code SHA, report SHA, and exact CI head SHA. The launcher must enforce equality before runtime start.
STRATEGY SEMANTICS CHANGED: NO

## P1-1

FINDING: Ambiguous symbol blocking is memory-only.
SEVERITY: P1
STATUS: CONFIRMED
FILES: `src/app/execution/SharedStrategyExecutionService.ts:31-50,160-175`
CURRENT BEHAVIOR: Unresolved market-open ambiguity is stored in an in-memory `Set<string>` and disappears after process restart.
WHY IT MATTERS: A future testnet/LIVE process could retry mutation for a symbol whose prior submission remains unresolved.
PROPOSED FIX: Persist unresolved ambiguity and restore it as a mutation block until explicit read-only reconciliation succeeds, or retain it as an explicit LIVE blocker.
STRATEGY SEMANTICS CHANGED: NO

## P1-2

FINDING: Bracket matching does not require bot ownership.
SEVERITY: P1
STATUS: CONFIRMED
FILES: `src/app/execution/SharedStrategyExecutionService.ts:748-765`
CURRENT BEHAVIOR: `exactBracket` validates type, price, side, position, working type, and close/reduce semantics, but accepts `owner: 'UNKNOWN'`.
WHY IT MATTERS: An identical manual order can be mistaken for bot protection.
PROPOSED FIX: Require `owner === 'BOT'` when ownership is available; reject unknown ownership as proof of protection and preserve cleanup restrictions.
STRATEGY SEMANTICS CHANGED: NO

## P1-3

FINDING: Runtime dependency advisories remain unresolved.
SEVERITY: P1
STATUS: CONFIRMED
FILES: `package.json`, `package-lock.json`
CURRENT BEHAVIOR: Fresh `npm audit --omit=dev --json` reports 5 high and 1 moderate vulnerability groups involving `axios`, `js-yaml`, `form-data`, `follow-redirects`, `adm-zip` via `onnxruntime-node`, and `onnxruntime-node`.
WHY IT MATTERS: The runtime and configuration paths retain known reachable dependency risk until each advisory is classified or safely remediated.
PROPOSED FIX: Classify direct/transitive reachability and safe patch availability. Apply only non-breaking safe updates; document risky or unpatched items as formally classified, not fixed.
STRATEGY SEMANTICS CHANGED: NO

## P1-4

FINDING: A new milestone report is required for post-audit changes.
SEVERITY: P1
STATUS: CONFIRMED
FILES: `docs/strategies/micro-burst/`
CURRENT BEHAVIOR: No M3.2.6.3 report exists yet; prior reports must remain historical.
WHY IT MATTERS: New code, CI, smoke, and soak evidence must not be attributed to an earlier SHA.
PROPOSED FIX: Create `M3_2_6_3_FINAL_DATA_INTEGRITY_REPORT.md` after implementation and exact-SHA verification.
STRATEGY SEMANTICS CHANGED: NO
