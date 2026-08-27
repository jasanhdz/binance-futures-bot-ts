# MICRO_BURST_V1 M3.2.3 - USD-M WebSocket Correction

## Status

`MICRO_BURST_V1_M3_2_BLOCKED`

## Correction

- Official USD-M raw WebSocket URLs are `wss://fstream.binance.com/ws/<stream>` and `wss://fstream.binance.com/stream?streams=<streams>` (with the equivalent testnet host). `/public` and `/market` are not raw URL path prefixes.
- `PUBLIC` and `MARKET` remain logical descriptors and hub keys, preventing subscriptions with the same stream name from colliding without changing the raw protocol URL.
- Partial-depth subscriptions now accept only Binance USD-M supported levels: 5, 10, and 20. `TradingService` requests top 20 at 100ms.

## Evidence Limitation

The previous request for an invalid depth level of 50 could not yield reliable data. The corrected top-20 stream is valid, but detector evidence is limited to the top 20 book levels; it does not establish full-book liquidity conditions.
