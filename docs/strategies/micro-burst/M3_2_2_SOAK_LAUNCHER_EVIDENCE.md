# MICRO_BURST_V1 M3.2.2 - Scoped Soak Launcher Evidence

## Status

`MICRO_BURST_V1_M3_2_2_LAUNCHER_READY_NO_SOAK_RUN`

This milestone adds only launch-time and graceful-shutdown evidence controls. No production soak was started or claimed by this change.

## Command

1. Build the committed checkout: `npm run build`.
2. Create an untracked local environment file from `config/m3_2_2_soak.env.example`.
3. Run `SOAK_ENV_FILE=/absolute/path/to/local.env SOAK_SECONDS=300 npm run micro-burst:production-soak-m3_2_2`.

The launcher requires at least 180 seconds. It starts `dist/main.js`, sends SIGINT at the requested duration, and allows 30 seconds for graceful shutdown.

## Preflight Evidence

Before the runtime starts, the launcher verifies and prints:

- Node version and local `ws` module capability.
- Requested seconds, compiled runtime path, and M3.2.2 config path.
- A deployment SHA. It derives `HEAD` only from a completely clean checkout; otherwise `GIT_COMMIT_SHA` must be an explicit 40-character hexadecimal SHA.
- SHADOW-only environment: `TRADING_MODE=AEGIS_SHADOW` and `AEGIS_LIVE_ENABLED=0`.
- `micro_burst.enabled: true`, `micro_burst.mode: SHADOW`, and isolated market archive and SQLite paths under `data/micro-burst/m3_2_2-soak/`.
- Absence of tracked live config or live archive references.

The launcher forcibly sets the isolated config, SHADOW mode, disabled live authority, disabled Telegram commands, and JSON logs after preflight.

## Final Health Evidence

At graceful shutdown the runtime emits a final `MICRO_BURST_SHADOW_HEALTH` record with `phase: graceful_shutdown`. It includes archive queue depth and queued, written, and overflow record counters.

The launcher retains all health and lifecycle records from its timestamped log, then requires the final graceful record to show:

- `archiveQueueDepth: 0`
- `archiveOverflowRecords: 0`
- `archiveQueuedRecords == archiveWrittenRecords`

Missing final health or any queue discrepancy fails the command. Retain the log, printed preflight evidence, exact config, redacted local environment, SHA, and isolated archive artifacts as the soak record.

## Scope Boundary

This does not establish official-cohort readiness, trade performance, Binance connectivity, crash durability, or LIVE authority. `MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED` remains false.
