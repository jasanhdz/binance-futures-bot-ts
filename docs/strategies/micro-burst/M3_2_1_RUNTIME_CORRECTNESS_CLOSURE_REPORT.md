# MICRO_BURST_V1 M3.2.1 - Runtime Correctness Closure

## Status

`MICRO_BURST_V1_M3_2_1_IMPLEMENTATION_READY_FOR_SOAK`

This change closes the local correctness work and prepares a bounded production-read-only soak. It does not record a soak result, establish an official cohort, or make any claim about Binance connectivity, data quality, archive durability under SIGKILL/power loss, or trading performance.

## Confirmed Fixed

- Typed routed subscriptions keep depth on `PUBLIC` and aggTrade/kline on `MARKET`; route and stream form are separate explicit dimensions. The runtime continues to use periodic REST mark-price fallback, while the typed `@markPrice` descriptor is correctly `MARKET` if enabled later.
- Archive writes use a bounded queue and background batches. Each immutable segment holds multiple records, has indexed range metadata and a checksum verified during replay. Overflow and corrupt segments create explicit gaps and unhealthy storage.
- TIME_SHIFT resolves the first archived trade at shifted T0 and evaluates return-only control semantics; it never reuses the original signal price.
- USD-M diff-depth bootstrap bridges `U <= lastUpdateId <= u`, then checks `pu` continuity. Stale books resynchronize and retain a 1000-level internal snapshot while exposing the feature depth only.
- AggTrade subscriptions return cancellation handles and runtime stop/start removes only the Micro Burst consumer.
- Decision price is an immutable closed-candle decision input with explicit provenance. Temporal book history is causal; signed imbalance and magnitude are distinct from anomaly detection.
- Terminal incomplete and capacity-evicted outcomes are durable and excluded from recovery. Cohort readiness is fail-closed with explicit blockers.
- SIGINT/SIGTERM await runtime shutdown and archive drain. SIGKILL/power loss can still lose the bounded in-memory queue tail.

## Still Open

- A real Binance production-path soak has not run.
- Official cohort governance, deployment SHA freeze, and a clean soak record remain required.

## Tested Locally

- `npm run build`
- Full Vitest regression suite.
- Focused transport, archive, order-book, controls, runtime lifecycle and readiness tests.

## Tested In CI

No CI query was available in this environment.

## Tested Against Real Binance

Not tested against real Binance in this milestone.

## Soak Preparation
- The command starts the compiled `src/main.ts` production path through `dist/main.js`; it does not use the older stand-alone smoke or soak probes.

## Configuration

- `config/micro-burst-m3_2_1-soak.yaml` sets `micro_burst.enabled: true` and `micro_burst.mode: SHADOW` for BTCUSDT and ETHUSDT.
- Ordinary Aegis symbols are OFF and the shell launcher forces `TRADING_MODE=AEGIS_SHADOW`, `AEGIS_LIVE_ENABLED=0`, and disabled Telegram commands.
- The archive root is `data/micro-burst/m3_2_1-soak`, separate from the live archive paths. The launcher refuses a caller-supplied `regime_config.live.yaml` override.
- `config/m3_2_1_soak.env.example` is a credential-free template. Local credentials, if a deployment requires them for read-only startup calls, are not versioned.

## Soak Command

1. Create a local environment file from `config/m3_2_1_soak.env.example`.
2. Run `SOAK_ENV_FILE=/absolute/path/to/local.env SOAK_SECONDS=300 npm run micro-burst:production-soak`.
3. The minimum duration is 180 seconds so the runtime has an opportunity to emit its 60-second health report more than once.
4. The launcher builds first, starts `dist/main.js`, sends SIGINT at the duration limit, and permits 30 seconds for graceful shutdown.

## Health Output

- The launcher prints retained `MICRO_BURST_SHADOW_HEALTH` records plus runtime start, stop, startup-failure, and cohort-readiness records from its timestamped log.
- Capture and review healthy book count, BTC health, evaluations, resyncs, signal journal health, market archive health, pending/completed outcomes, and storage errors.
- Confirm a `micro_burst_runtime_stopped` record after SIGINT. This exercises the existing runtime stop path, including its journal, outcome, and archive flush calls.

## Evidence Required

- Retain the launcher log, exact config, local environment redacted of secrets, committed deployment SHA, start/end timestamps, and isolated archive/SQLite paths.
- Verify that health records cover depth, aggregate trades, mark price, BTC context, evaluation, archive health, reconnect/resync behavior, gaps, and storage errors.
- Independently inspect the isolated archive and SQLite artifacts after shutdown. This preparation does not prove a queue drain or crash durability.

## Safety

- `MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED` remains false.
- The soak configuration selects SHADOW, not LIVE. No execution authority is added by this change.
- The command does not select or write to the tracked live archive configuration or its default archive paths.
- No real Binance run has been performed or asserted in this report.

## Closure Decision

M3.2.1 implementation is ready for soak. Runtime correctness remains operationally unverified until a retained main-path soak satisfies the evidence requirements. Official cohort activation and any LIVE_READY conclusion remain out of scope.
