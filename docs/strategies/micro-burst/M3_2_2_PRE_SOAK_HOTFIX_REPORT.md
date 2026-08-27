# MICRO_BURST_V1 M3.2.2 - Pre-Soak Hotfix

## Verdict

`MICRO_BURST_V1_M3_2_2_READY_FOR_PRODUCTION_SOAK`

No real Binance soak was run for this hotfix.

## Audit

| Finding                              | Status    | Severity | Root cause                                             | Fix                                      | Test                               |
| ------------------------------------ | --------- | -------- | ------------------------------------------------------ | ---------------------------------------- | ---------------------------------- |
| Fresh health requested snapshots     | Confirmed | P0       | Missing braces made `syncFromSnapshot()` unconditional | Stale transition is explicitly guarded   | Fresh and stale health tests       |
| `resyncCount` reset after recovery   | Confirmed | P1       | Success path reset cumulative diagnostic               | Counter remains monotonic                | Repeated desync test               |
| Production socket depended on global | Confirmed | P0       | Default factory used `globalThis.WebSocket`            | Direct `ws` dependency and event adapter | Factory event tests without global |
| Soak preflight was incomplete        | Confirmed | P0       | Launcher lacked SHA/config/archive/runtime checks      | Fail-closed M3.2.2 launcher              | Shell helper tests                 |

## Confirmed Fixed

- Fresh `getHealth()` calls do not request snapshots. A stale book starts one recovery attempt, and repeated health checks do not create a snapshot storm.
- `resyncCount` is cumulative over the runtime lifetime.
- Market data uses the direct Node `ws` implementation, while fake socket injection remains supported in tests.
- The launcher validates Node, `ws`, clean committed SHA, configuration, isolated archive paths, SHADOW mode, disabled Aegis live authority, and the 180-second minimum.
- Graceful shutdown emits final archive queue evidence and fails the launcher on an undrained queue, overflow, or unexplained queued/written mismatch.

## Safety And Provenance

- `TRADING_MODE=AEGIS_SHADOW`, `AEGIS_LIVE_ENABLED=0`, and Micro Burst SHADOW mode are asserted before launch.
- The run is labelled pre-official and does not establish cohort readiness merely from a SHA.
- `MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED` remains false; no exchange mutation path was added.

## Tests

- `npm run build`
- `npm run test:micro-burst-soak-launcher`
- Focused order-book, WebSocket factory, hub, and runtime tests.
- Full Vitest regression suite.

## CI

GitHub Actions was queried after the code commit and was in progress. No CI success is claimed here.

## Soak Status

Not tested against real Binance. Run `SOAK_ENV_FILE=/absolute/path/to/local.env SOAK_SECONDS=300 npm run micro-burst:production-soak-m3_2_2` from a clean committed checkout to collect the required evidence.

## Remaining Blockers

- Successful retained 300-second production read-only soak for BTCUSDT and ETHUSDT.
- Review of soak logs, archive artifacts, queue drain, and zero-mutation evidence.
- Separate explicit governance decision before any official prospective cohort.
