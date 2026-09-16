# Micro Burst Entry Latency Fix

## Finding

The historical XRPUSDT and SUIUSDT records cannot identify the exact sizing
denial because the deployed rejection log discarded `sizingReason`. The
measured 62-67 second interval is consistent with the entry admission path
scanning the complete `logs/aegis` history before shared execution. That
directory is currently about 852 MB. The scan was repeated for every entry and
could allow the original signal to expire before final validation.

The failure is reproduced deterministically by delaying admission until the
signal freshness window expires. It is not safe to solve that case by sending
an expired signal.

## Changes

- Cache parsed closed-trade outcomes per journal file, keyed by directory and mode.
- Re-read only files whose size or modification time changed.
- Preserve `sizingReason` as `reasonDetail`, with wallet and notional evidence.
- Preserve `decisionId` and record monotonic outcome-read duration for future LIVE observations.
- Keep external `INVALID_SIZE` compatibility and all safety checks unchanged.

## Validation

- Deterministic sizing and durable-entry tests pass.
- History-reader tests cover unchanged-file reuse and changed-file refresh.
- Full offline suite and build must remain green before publication.

## Pending LIVE Observation

- Confirm the next valid Micro intent reaches the shared execution port within
  its freshness window.
- Confirm any denial contains `decisionId`, `reasonDetail`, and the sizing
  evidence fields without exposing credentials.
- No LIVE restart or real order was performed for this change.
