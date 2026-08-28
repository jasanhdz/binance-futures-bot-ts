# M3.2.6.3 Data-Integrity Report

Status: **PRE-SOAK QUALIFIED, RETAINED SOAK NOT STARTED**

## Provenance

- Repository: `jasanhdz/binance-futures-bot-ts`
- Branch: `work/micro-burst-rider-v1-20260826`
- Implementation HEAD before this report: `2ef45d2a4f92bd0205c3c04b8e14abf94769b4b0`
- Base SHA: `c0b9ec908603d59d570abd4965bec33331a7e53d`
- CI run: `33129329024`
- CI head SHA: `2ef45d2a4f92bd0205c3c04b8e14abf94769b4b0`
- CI result: `completed / success`

## Verification

- `npm run build`: passed
- `npm run test`: passed, 106 files and 1,169 tests
- `git diff --check`: passed
- Production-path SHADOW smoke: passed for 90 seconds
- Smoke evidence: BTC depth 874 and AggTrade 1,584; ETH depth 871 and AggTrade 1,040; reconnects 0; stale loops 0; clean unsubscribe true; exchange mutations 0

The smoke exercised `BinanceExchange -> WebSocketManager -> MarketDataHub -> direct ws` for BTCUSDT and ETHUSDT. No official cohort was created and no state-changing exchange request was issued.

## Implemented Controls

- AggTrade gaps are bounded, event-time scoped, deduplicated, persisted, and restored into readiness checks.
- BTC candle eligibility uses exchange snapshot time; local time remains transport-freshness metadata.
- Production WebSocket routing and lifecycle are covered by tests and the production-path smoke.
- The SHADOW launcher requires a clean tree, exact CI SHA, verified production smoke, isolated run root, immutable manifest, and at least 900 seconds.
- Bracket matching rejects non-`BOT` ownership when ownership is supplied.

## Dependency Audit

Fresh `npm audit --omit=dev` reports two high findings:

- `onnxruntime-node@1.23.2 -> adm-zip@0.5.16`: crafted ZIP allocation denial of service, fixed only by the available ONNX upgrade.

Safe direct updates were applied and verified:

- `axios`: `1.11.0` to `1.20.0`
- `js-yaml`: `4.1.1` to `4.3.2`
- `follow-redirects`: `1.15.11` to `1.16.0`
- `form-data`: `4.0.5` to `4.0.6`

The ONNX upgrade was not applied because it is a native runtime upgrade and requires a separate compatibility test. `npm audit fix` was not run.

## Remaining Blockers

- The dependency advisory above remains formally classified but unresolved.
- Unresolved market-open ambiguity is memory-only and remains a future testnet/LIVE blocker until persisted and reconciled.
- The 900-second retained soak has not started. The launcher requires the final committed SHA and matching CI head SHA; this report and dependency changes are currently uncommitted.
- Official Binance documentation evidence was unavailable in the audit environment, although live production-path smoke passed.
- No official cohort or M3.3 work is authorized by this report.

## Verdict

The implementation and production data path are ready for a controlled retained SHADOW soak only after the remaining blockers are explicitly accepted or resolved, the final changes are committed, CI passes on that exact SHA, and the launcher is run with `MICRO_BURST_SOAK_DURATION_SECONDS >= 900`.
