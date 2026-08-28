# M3.2.6.4 Final Pre-Soak Evidence Report

## Verdict

`MICRO_BURST_V1_M3_2_6_4_BLOCKED`

The exact 900-second SHADOW qualification ran for 904.929 seconds, but the retained run is not correctness-verified because both production AggTrade feeds recorded persistent sequence gaps. No official cohort or M3.3 work was started.

## Provenance

- Repository: `jasanhdz/binance-futures-bot-ts`
- Branch: `work/micro-burst-rider-v1-20260826`
- Base SHA: `c0b9ec908603d59d570abd4965bec33331a7e53d`
- Final code SHA: `baed55f5b10e3ef57b0d1951c950769d06458062`
- CI: run `33132391509`, head `baed55f5b10e3ef57b0d1951c950769d06458062`, success
- Smoke run: `20260828011729881-baed55f5b10e`
- Smoke code SHA: `baed55f5b10e3ef57b0d1951c950769d06458062`
- Soak run: `20260828012014923-baed55f5b10e`
- Manifest SHA256: `f9c68f1e93982a32694084c6012f032a40441738abf2c0688e7a426c66baaaff`
- Report SHA: assigned by the commit containing this report

## P0 Closure

- Duplicate AggTrade archive: fixed. Runtime owns live archival; tracker observes without re-archiving. Soak storage reconciled exactly.
- Real mutation audit: fixed. Read-only audited exchange recorded 1,474 read-only calls, 0 attempts, 0 blocked, and 0 forwarded mutations.
- Post-shutdown verification: fixed. SQLite integrity `ok`; 34 gzip files, 34 metadata files, 34 DB rows; 80,904 actual records and SQLite records; checksum errors `0`; temporary files `0`.
- Smoke SHA binding: fixed. Smoke evidence SHA equals code SHA and CI head SHA.
- Readiness stability: failed. `firstReadyAt=null`, `maxContinuousReadySeconds=0`, `readinessLosses=0`, final ready `false`.
- Remaining P0: AggTrade gap readiness failure prevents qualification.

## Archival

- BTCUSDT AggTrade callbacks/archived records: `42,225`
- ETHUSDT AggTrade callbacks/archived records: `21,011`
- BTCUSDT depth records: `8,847`
- ETHUSDT depth records: `8,821`
- Total accepted: `80,904`
- Total written: `80,904`
- Duplicate ratio: `1.0`
- Single owner: `MicroBurstRuntime`

## Mutation Audit

- Wrapper enabled: yes
- Mutation attempts: `0`
- Blocked attempts: `0`
- Forwarded mutations: `0`
- Official/live authority: `false` / `false`

## Storage

- Accepted/written: `80,904 / 80,904`
- Actual NDJSON records: `80,904`
- Segments/gzip/metadata/DB rows: `34 / 34 / 34 / 34`
- SQLite integrity: `ok`
- Checksum errors: `0`
- Active final: `0`
- Temporary final: `0`
- Overflow/storage errors/recovery failures: `0 / 0 / 0`
- Signals/outcomes/pending: `0 / 0 / 0`

## Smoke

- Run ID: `20260828011729881-baed55f5b10e`
- Code SHA: `baed55f5b10e3ef57b0d1951c950769d06458062`
- Duration: `90s`
- BTC depth/ETH depth: `875 / 868`
- BTC AggTrade/ETH AggTrade: `7,222 / 2,911`
- Reconnects: `0`
- Mutations: `0`
- Verdict: `MICRO_BURST_V1_PRODUCTION_PATH_MARKET_DATA_SMOKE_VERIFIED`

## Readiness And Gaps

- Soak duration: `904.929s`
- First ready: none
- Continuous ready: `0s`
- Readiness losses: `0`
- Final ready: `false`
- Current gaps: `425` persisted sequence gaps
- BTC and ETH both reported `AGG_TRADE_GAP` and `AGG_TRADE_WINDOW_INCOMPLETE`
- Gap retention is bounded and expired dedupe keys are removed.

The observed gaps are not suppressed or reclassified. A new qualification run requires the feed to remain gap-free for the required causal window.

## P1 And Security

- AggTrade ordering: current production path assumes Binance WebSocket delivery order; observed gaps are recorded conservatively rather than hidden.
- ONNX advisory: `onnxruntime-node -> adm-zip` remains a known high advisory, not reachable in this soak path because no ONNX session is loaded. Resolve and test before any ONNX-loading release path.
- Ambiguous MARKET persistence: unresolved; separate `SHARED_EXECUTION_TESTNET_LIVE_BLOCKERS_REMAIN`, not a SHADOW mutation-path blocker.
- Bracket ownership: enforced when ownership is supplied; shared execution is not declared LIVE-ready.

## Authorization

- Micro Burst mode: `SHADOW`
- `official`: `false`
- `liveExecution`: `false`
- Official cohort started: `false`
- Ready for M3.3: `false`
- M3.3: not authorized

## Evidence Files

- Smoke: `data/micro-burst/smokes/m3_2_6_4/20260828011729881-baed55f5b10e/smoke-result.json`
- Manifest: `data/micro-burst/soaks/m3_2_6_final/20260828012014923-baed55f5b10e/manifest.json`
- Result: `data/micro-burst/soaks/m3_2_6_final/20260828012014923-baed55f5b10e/result.json`
- Storage validation: `data/micro-burst/soaks/m3_2_6_final/20260828012014923-baed55f5b10e/storage-validation.json`
- Mutation audit: `data/micro-burst/soaks/m3_2_6_final/20260828012014923-baed55f5b10e/http-mutation-audit.json`
