# Market Data Diagnostics

`01-Trading-Bot` exposes `GET http://127.0.0.1:8010/diagnostics/market-data`.

The endpoint reads the in-process `SharedMarketDataRuntime` only. It does not
call Binance, open streams, trigger recovery, or expose credentials, balances,
orders, signals, or decisions. The response is versioned as
`MARKET_DATA_DIAGNOSTICS_V1` and includes the canonical 11-symbol market-data
health, stream status, candle freshness, continuity counters, and local
rate-limit metrics.

The port can be overridden with `BOT_DIAGNOSTICS_PORT`; binding remains limited
to `127.0.0.1`.
