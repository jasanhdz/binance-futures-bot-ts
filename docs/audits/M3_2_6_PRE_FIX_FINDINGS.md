# M3.2.6 Pre-Fix Correctness And Safety Findings

**Baseline:** `177ba3990fdbfd2d86265b91663cba39b2737770` on `work/micro-burst-rider-v1-20260826`.
The working tree was clean. CI run 73 completed successfully for this exact SHA. M3.2.5 retained
run `20260827T193200Z` remains intact and qualified. Micro Burst version is
`0.5.0-event-time-prospective`; live config SHA-256 is `2d6cca…2165` and the retained soak config
SHA-256 is `32e1b2…1a3a`.

## Confirmed Findings

| ID | Severity | Code path | Why it matters | Affected | Minimal correction | Semantic change |
| --- | --- | --- | --- | --- | --- | --- |
| EX-1 | P0 | `SharedStrategyExecutionService.execute` | Lost MARKET response is treated as rejection; no deterministic client ID or reconciliation precedes retry/failure. | Aegis, Momentum, future LIVE | Idempotent client ID plus reconcile-before-retry. | Yes, fail closed. |
| EX-2 | P0 | `BinanceAdapter.closeSideMarketSafe`, `isHedgeMode` | Close fallback drops side/reduction protection; hedge lookup failure assumes one-way. | LIVE | Explicit one-way/hedge/unknown paths; unknown blocks mutation. | Yes, prevents reversal. |
| EX-3 | P0 | `ensureMarginType`, `setLeverage`, bracket verification/cleanup | Ambiguous margin/leverage accepted; stale/wrong brackets can verify; cleanup is incomplete. | LIVE | Read-back and exact bracket ownership/trigger verification. | Yes, safety only. |
| MB-1 | High | `SynchronizedOrderBook` bootstrap | REST/diff bridge is off by one (`lastUpdateId` rather than `lastUpdateId + 1`). | SHADOW evidence, future LIVE | Correct bridge predicate and regression test. | Yes, data correctness. |
| MB-2 | High | `MicroBurstShadowEvaluator`, context builder | Exchange/server snapshot time is subtracted from local receive time; reference-price provider is unwired. | SHADOW evidence | Separate exchange event and local freshness clocks; wire valid reference price. | Yes, causal correctness. |
| MB-3 | High | `MicroBurstOutcomeTracker` | Normal completed horizons are not persisted until shutdown; late trade ordering can truncate history; watermark is assumed gap-free. | Prospective outcomes | Complete on maturity, use event watermark/history, declare and detect feed gaps. | Yes, evidence correctness. |
| MB-4 | High | `MicroBurstOutcomeTracker` episode ID | Symbol/side/rounded-stop identity is infinite-lived and non-restart-safe. | Statistical independence | Deterministic, outcome-window-overlap episode clustering. | Yes, analysis semantics. |
| MB-5 | High | `MicroBurstProspectiveAnalyzer`, journals | Cohort identity is not authoritative in grouping; duplicate/malformed rows can be silently suppressed; SQLite authority is incomplete. | Cohort isolation | Explicit cohort selection, SQLite-first reconciliation, report mismatches. | Yes, analysis semantics. |
| MB-6 | Medium | `MicroBurstAggTradeBuffer` | A 200-record cap silently shortens the intended five-minute flow horizon; cutoff mixes exchange event and local clocks. | SHADOW evidence | Time-first retention and explicit capacity-truncation diagnostics. | Yes, feature semantics/version. |
| MB-7 | Medium | gaps/outcome dependencies | Gaps are untyped, so outcome invalidation cannot depend on its required feed. | Outcomes, attrition | Backward-compatible typed-gap migration and feed-specific query. | Yes, evidence correctness. |
| MB-8 | Medium | cost/dynamic-exit calculations | Conservative entry adjustment and scenario slippage are ambiguous; dynamic `net` is gross. | Analysis | Explicit components and accurate labels without retrospective tuning. | Yes, report semantics. |
| ST-1 | Medium | `MicroBurstStorage.appendRaw` | Capacity measures all active-spool records, including durable disk-backed records. | SHADOW evidence | Restrict capacity to actual in-memory/in-flight pressure. | No strategy change. |
| ST-2 | High | archive finalization/recovery | Random final names can duplicate content if gzip/meta exist before SQLite insert fails. | Archive authority | Deterministic content segment ID and unique index/recovery. | No strategy change. |
| RK-1 | High | `StrategyRiskLedger`, `TradingService` | Daily entry counts reset/reconstruct incorrectly after restart; global counter overlaps strategy semantics. | Aegis, Momentum, future LIVE | Durable/reconstructed UTC-day ledger. | Yes, safety only. |
| RK-2 | High | lifecycle close reconciliation | Mark price is used as realized close/PnL after position disappearance; close is not confirmed flat. | Aegis, Momentum, future LIVE | Reconcile actual fills/PnL or retain unknown-close fail-safe state. | Yes, safety only. |
| ST-3 | High | `FsStateStore` | Fire-and-forget shared-path state writes are not flushable or process-safe; corrupt JSON defaults to safe-looking state. | Aegis, Momentum, LIVE | Atomic unique-temp flush and corrupt-state reconciliation block. | Yes, safety only. |
| SU-1 | Medium | startup/config | Numeric validation is permissive; explicit zero values can be defaulted in callers. | Runtime, LIVE | Nullish/default discipline and validated startup failure. | Yes, fail closed. |
| TG-1 | Medium | Telegram `/riskmode` | Help claims read-only while policy mutation needs only chat authorization. | Aegis policy | Separate disabled-by-default mutation authority, user ID, audit trail. | Yes, security contract. |
| AG-1 | Medium | `LiquidityVoidDetector` | Bid-only concentration and duplicate bid assignment leave ask-side data unused/stale. | Aegis | Correct accidental assignment; keep enforcement semantics shadowed pending policy decision. | No enforcement tuning. |
| SEC-1 | High | production dependencies | `npm audit --omit=dev`: 5 high, 1 moderate (`axios`, `js-yaml`, `onnxruntime-node` chain). | Runtime security | Targeted compatible updates, then re-audit. | No strategy change. |

## Falsified Or Partially Confirmed

| ID | Status | Evidence | Action |
| --- | --- | --- | --- |
| B-anomalous resync storm | Falsified | `SynchronizedOrderBook` uses `isSyncing` and clears state before guarded resync. | Do not redesign. |
| B stale freshness local-time use | Falsified | Book staleness intentionally uses local receive time. | Preserve local transport freshness; fix only mixed-domain consumers. |
| production live enabled by mode alone | Falsified | Execution also requires environment and YAML/symbol live gates. | Retain existing gates. |
| Telegram public mutation by default | Falsified | Listener is disabled by default and chat allow-listed. | Fix privileged mutation contract only. |
| bid/ask enforcement semantics | Partially confirmed | Asymmetry is real, intent is unclear. | Fix duplicate assignment only; add V2 diagnostics rather than tune enforcement. |

## Security Audit

`npm audit --omit=dev` found 0 critical, 5 high, 1 moderate production vulnerabilities. Direct
packages include `axios`, `js-yaml`, and `onnxruntime-node`; transitive packages include `adm-zip`,
`follow-redirects`, and `form-data`. No dependency upgrade is applied before compatibility review.
No secret values were inspected or printed by this audit.

## Scope Declaration

No strategy threshold, leverage, sizing, position fraction, risk-policy tuning, live authority, or
official cohort state is changed by this audit. Every correction must add deterministic coverage and
declare its evidence/execution semantic effect.
