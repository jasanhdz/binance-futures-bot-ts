# Micro Burst Entry Latency Fix

## Finding

The historical XRPUSDT and SUIUSDT records cannot identify the exact sizing
denial because the deployed rejection log discarded `sizingReason`.

Correction to the initial report: 852 MB was the size of the directory, not
the bytes read by this reader. It selects only `turbo_trades_YYYY-MM-DD.jsonl`;
the inspected directory contained `turbo_trade_events_*`, account snapshots and
signals, but no matching trade files. The assertion that a repeated 852 MB scan
caused the LIVE delays was not demonstrated and is withdrawn. Caching changed
files is an optimization, not evidence of the historical cause. It rereads an
entire changed file; it is not incremental byte-tail parsing.

An offline delay test demonstrates rejection of an expired signal, not the
source of the LIVE delay. It is not safe to solve that case by sending an expired signal.

## Changes

- Cache parsed closed-trade outcomes per journal file, keyed by directory and mode.
- Re-read only files whose size or modification time changed.
- Preserve `sizingReason` as `reasonDetail`, with wallet and notional evidence.
- Preserve `decisionId` and record monotonic outcome-read duration for future LIVE observations.
- Keep external `INVALID_SIZE` compatibility and all safety checks unchanged.

## Validation

- Deterministic sizing and durable-entry tests pass.
- History-reader tests cover unchanged-file reuse and changed-file refresh.
- Full serial offline suite: 224 files and 2,952 tests, exit code 0.
- Build: passes.
- Controlled 300-record fixture: cold read 0.65 ms, warm read 0.08 ms; both returned identical accounting.
- A fresh child process reconstructed the same 300 outcomes after restart.

## Pending LIVE Observation

- Confirm the next valid Micro intent reaches the shared execution port within
  its freshness window.
- Confirm any denial contains `decisionId`, `reasonDetail`, and the sizing
  evidence fields without exposing credentials.
- No LIVE restart or real order was performed for this change.
