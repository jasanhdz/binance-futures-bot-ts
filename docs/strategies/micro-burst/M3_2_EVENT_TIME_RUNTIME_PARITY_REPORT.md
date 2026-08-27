# MICRO_BURST_V1 M3.2 - Event-Time And Runtime Parity

## Status

`MICRO_BURST_V1_M3_2_BLOCKED`

The implementation is compiled and covered by the full automated test suite. An official prospective cohort remains blocked until a production read-only soak verifies the routed WebSocket paths and archive health with a committed deployment SHA.

## Completed

- Public market streams use raw routed WebSockets: `/public` for depth and `/market` for aggregate trades, candles, and mark price. Private user data remains separate.
- `TradingService` resolves one typed Micro Burst configuration and registers the SHADOW runtime once. Incomplete legacy test adapters fail Micro Burst closed.
- BTC context polling is periodic, non-overlapping, retrying, and has idempotent lifecycle cleanup.
- Live archive writes are queued rather than gzip/file/SQLite work on the market-data callback path. Segments have immutable UUID names and SQLite range indexes.
- Aggregate trades are canonically deduplicated and event-time ordered. Live ingestion archives records; archive replay never re-archives them.
- Horizon evaluation uses event-time watermarks and recorded gaps. Missing coverage remains incomplete instead of being classified as a zero outcome.
- SQLite completion precedes JSONL export and records JSONL divergence for recovery. Terminal states cannot regress.
- The prospective analyzer can read SQLite/archive data and recompute deterministic random-side and time-shift controls.

## Verified

- `npm run build`
- `npx vitest run` - 102 files and 1042 tests passed.

## Remaining Operational TODO

- Run and retain a greater-than-180-second production read-only soak using the committed deployment SHA; verify depth, aggregate-trade, mark-price, BTC context, archive queue, gaps, and reconnect metrics.
- Add a deployment shutdown drain and prove it in the real process lifecycle before treating archive capture as crash-durable. A forced process termination before the in-process queue drains can lose queued records.
- Confirm archive retention/disk monitoring and start a new immutable official cohort only after the preceding gates are satisfied.

## Safety

`MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED` remains `false`. The runtime does not call shared execution or any exchange mutation method.
