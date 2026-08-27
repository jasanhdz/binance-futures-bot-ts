# M3.2.3 Shared Depth Transport Report

## Outcome

M3.2.3 is complete at commit `da8a3d0eb370b3a254b56941d8ea27d05eae91d2`.
The shared partial-depth subscription used by `LiquidityVoidDetector` now requests the supported Binance USD-M stream `depth20@100ms` over the existing public route. Market routes and the shared transport topology were not changed.

## Root Cause and Scope

The normal runtime opened `depth50@100ms` sockets but received no messages. The watchdog then repeatedly reported `market_data_ws_stale` and reopened each depth socket.

An isolated websocket probe on 2026-08-27 established the environment-specific routing contract:

| Route and stream                                            | Result                      |
| ----------------------------------------------------------- | --------------------------- |
| `wss://fstream.binance.com/public/ws/btcusdt@depth20@100ms` | Received `depthUpdate`      |
| `wss://fstream.binance.com/public/ws/btcusdt@depth50@100ms` | Timed out without a message |
| `wss://fstream.binance.com/market/ws/btcusdt@aggTrade`      | Received `aggTrade`         |
| Raw `/ws` for `btcusdt@aggTrade`                            | Timed out without a message |

The initial raw-route interpretation was deployed in `91a822d` and caused both market and kline streams to become stale. It was immediately reverted by `5ffd7b4`. The final correction deliberately retains the established `PUBLIC` and `MARKET` route descriptors.

## Implementation

- `TradingService` requests `subscribeToPartialDepth(symbol, 20, '100ms', ...)`.
- `WebSocketManager.connectPartialDepth()` rejects unsupported levels. The allowed levels are `5`, `10`, and `20`.
- The existing public depth route, market agg-trade route, market kline route, `MarketDataHub` fan-out, and reconnect/watchdog behavior remain unchanged.
- No strategy threshold, risk, leverage, entry, exit, execution, or configuration values were changed.

This is not parity with a 50-level book: Binance did not deliver the previous 50-level stream. The detector now receives a real supported top-20 partial book rather than an empty/stale top-50 subscription.

## Validation

- `npm run build`: passed.
- `npx vitest run`: passed, 103 files and 1061 tests.
- GitHub Actions `build-and-test`: passed for `da8a3d0`.
- Normal `01-Trading-Bot` PM2 observation: 5 minutes online after deployment, all eleven `depth20@100ms` streams opened, with no post-deployment `market_data_ws_stale` or depth reconnect entries.
- Isolated command: `SOAK_ENV_FILE=/tmp/opencode/micro-burst-m3_2_3-soak.env SOAK_SECONDS=300 npm run micro-burst:production-soak-m3_2_2`.
- The isolated runtime was `AEGIS_SHADOW` with `AEGIS_LIVE_ENABLED=0`, configured only for BTCUSDT and ETHUSDT Micro Burst observation.
- The final `MICRO_BURST_SHADOW_HEALTH` record reported `healthyBooks=2`, `btcHealthy=true`, `resyncs=0`, `liveExecution=false`, `marketArchiveHealthy=true`, `archiveQueueDepth=0`, `archiveQueuedRecords=14373`, `archiveWrittenRecords=14373`, and `archiveOverflowRecords=0`.
- SQLite evidence at `data/micro-burst/m3_2_2-soak/micro_burst_research.sqlite` contains 14,373 `market_data_segments` and zero `market_data_gaps`; immutable depth and trade archives exist for BTCUSDT and ETHUSDT.
- Soak log: `logs/micro-burst/m3_2_2-soak/soak-20260827T165248Z.log`.
- Post-soak authenticated read-only audit: `/tmp/opencode/micro-burst-m3_2_3-post-soak-audit/readonly_audit_network_counters.json` recorded 5 authenticated GETs and zero mutation, order, trade, cancellation, leverage/margin, money-movement, non-GET, retry, and rate-limit events. The account audit recorded ONE_WAY mode, zero active positions, and zero open regular or algo orders.

## Safety Status

Micro Burst remained SHADOW-only throughout. The prospective cohort remained blocked by `CODE_COMMIT_SHA_UNKNOWN`, `COHORT_NAMESPACE_INVALID`, and `OFFICIAL_COHORT_NOT_READY`; it was not started. No exchange mutation was issued by the post-soak audit, and no strategy live authority was enabled.
