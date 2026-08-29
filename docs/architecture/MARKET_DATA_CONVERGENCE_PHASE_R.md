# Market Data Convergence — Phase R

**Status:** IMPLEMENTED, CI QUALIFICATION REQUIRED  
**Phase:** R — remove Micro Burst ownership of generic market mechanics

## Resulting ownership

The following mechanics are now canonical under `src/core/market-data`:

- `MarketDataClocks.ts` — exchange/local clock-domain helpers and server-offset estimation;
- `NormalizedMarketEvents.ts` — normalized AggTrade/depth envelopes, gap vocabulary, and lossless parsers;
- `DepthStreamGapDetector.ts` — generic normalized-depth sequence continuity detector;
- `RollingAggTradeBuffer.ts` — canonical rolling AggTrade state (already shared before R);
- `SynchronizedOrderBook.ts` — canonical synchronized book state (already shared before R).

`WebSocketManager` now imports normalized parsers directly from the shared core. Generic transport therefore no longer depends on `src/app/micro-burst`.

## Compatibility/reference surfaces retained

The old files below intentionally remain readable, but no longer contain the generic mechanics they originally owned:

- `src/app/micro-burst/MicroBurstClocks.ts` — re-export only;
- `src/app/micro-burst/MicroBurstMarketData.ts` — re-export only;
- `src/app/micro-burst/MicroBurstStreamGapDetector.ts` — re-export only;
- `src/domain/strategies/micro-burst/MicroBurstAggTradeBuffer.ts` — alias only;
- `src/domain/strategies/micro-burst/SynchronizedOrderBook.ts` — thin strategy compatibility adapter for `getSnapshotForPressure`; synchronization remains entirely shared.

These compatibility surfaces can be deleted later once historical tooling and remaining strategy imports are deliberately migrated. Their presence does not imply ownership of market mechanics.

## What remains strategy/research-owned

The following are deliberately not generalized in Phase R:

- `MicroBurstFeedDependencies` — declares what Micro Burst requires;
- book-pressure, momentum, BTC-conflict, reference-price preference, entry/exit policies;
- outcome journals/trackers;
- Micro Burst paper/research storage and trade-history stores.

They encode strategy or evidence semantics, not reusable raw market mechanics.

## Invariants

Phase R changes namespace/ownership only. It does not authorize or modify:

- Aegis or Momentum inputs/decisions;
- Micro Burst entry/exit policy;
- generic ShadowTradingEngine semantics;
- LIVE risk, sizing, ownership, brackets, or execution;
- Binance mutation authority;
- deployment or PM2 restart.

Phase S remains a separate read-only operational soak and is not started by this change.
