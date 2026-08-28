# M3.2.6.4 Final Pre-Soak Findings

Audited HEAD: `2e434847c13820ecc18751aa96aae6f32015162a`

## P0-1: Duplicate AggTrade Archive

- Status: CONFIRMED
- Files: `MicroBurstRuntime.ts`, `MicroBurstOutcomeTracker.ts`
- Current behavior: both runtime and live tracker ingestion called `appendTrade` on the shared storage.
- Impact: accepted and written archive counters could represent approximately 2x the actual WS callbacks.
- Root cause: live observation implicitly owned archival.
- Fix: runtime owns live archival; tracker exposes an explicit non-archiving observation path. Standalone live tracker ingestion still archives.
- Strategy semantics changed: NO

## P0-2: Hardcoded Mutation Audit

- Status: CONFIRMED
- Files: `scripts/micro-burst-m3_2_6_3-soak.ts`, `scripts/micro-burst-production-path-shadow-smoke.ts`
- Current behavior: both artifacts previously wrote constant zero mutation totals.
- Impact: no evidence existed for attempted versus forwarded state-changing calls.
- Root cause: no audited exchange boundary.
- Fix: `createReadOnlyAuditedExchange` blocks and records all mutation-capable Exchange methods without forwarding them. Smoke and soak consume the live counters.
- Strategy semantics changed: NO

## P0-3: Post-Shutdown Storage Verification

- Status: CONFIRMED
- Files: `scripts/micro-burst-m3_2_6_3-soak.ts`
- Current behavior: verdict was assembled from pre-stop health only.
- Impact: finalization, SQLite integrity, checksum, and temporary-file failures could be missed.
- Root cause: no post-close read-only validator.
- Fix: runtime stop, WS disconnect, storage flush/close, then read-only SQLite and archive validation before writing the result.
- Strategy semantics changed: NO

## P0-4/P0-5: Exact Evidence Binding

- Status: CONFIRMED
- Files: production smoke and soak launcher.
- Current behavior: an environment boolean could stand in for smoke evidence.
- Impact: an older or failed smoke could be manually presented as current.
- Root cause: no machine-readable smoke artifact or SHA comparison.
- Fix: smoke writes `smoke-result.json` with SHA, branch, clean-tree status, metrics, mutation audit, and verdict. Launcher requires matching SHA, successful verdict, 90-second duration, all feeds, and zero mutation attempts. CI run ID is recorded separately.
- Strategy semantics changed: NO

## P1 Findings

- Gap dedupe keys are now rebuilt from retained intervals, so expired keys cannot grow without bound.
- Binance AggTrade delivery is treated as ordered by the production WebSocket contract; no reordering logic was added. Existing sequence-gap tests remain deterministic.
- `onnxruntime-node -> adm-zip` remains a known high advisory and is not loaded by the M3.2.6.4 SHADOW soak path. It remains a release blocker for paths that load ONNX.
- Ambiguous market-open persistence remains a separate testnet/LIVE blocker, not a SHADOW soak blocker.
- Bracket ownership remains enforced when ownership is supplied; shared execution is not declared LIVE-ready.
