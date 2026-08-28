# Shared Market Features V1

**Schema:** `SHARED_MARKET_FEATURES_V1` (`schemaVersion: 1`)

This dictionary defines the small strategy-neutral feature set introduced by
Phase O. These values describe measurable market state only. They do not know
symbol side, candidate side, entry, exit, strategy, position, or outcome.

All canonical feature objects are immutable. A numeric value is present only
when its source quality and causal completeness support that value. Otherwise
the value is `null` and the family health identifies why it is unavailable.

## Quote Features

| Name        | Formula                     | Unit         | Source                  | Timestamp                    | Health prerequisite              |
| ----------- | --------------------------- | ------------ | ----------------------- | ---------------------------- | -------------------------------- |
| `spreadBps` | `(ask - bid) / bid * 10000` | basis points | healthy `QuoteSnapshot` | `QuoteSnapshot.observedAtMs` | `HEALTHY`, finite bid/ask/spread |

The quote calculator preserves source health and never maps an unhealthy or
invalid quote to zero. Crossed or empty quotes are rejected by the existing
quote provider before this calculator.

## Order Book Features

`Top5` and `Top10` mean the five or ten best **price levels**, not a price
distance. Bids are ordered from highest to lowest price; asks from lowest to
highest price. Depth values are counts of available levels, not quantities.

| Name                   | Formula/meaning                                          | Unit                      | Source           | Timestamp                     | Health prerequisite                |
| ---------------------- | -------------------------------------------------------- | ------------------------- | ---------------- | ----------------------------- | ---------------------------------- |
| `signedImbalanceTop5`  | `(bidQty - askQty) / (bidQty + askQty)` over five levels | dimensionless, `[-1, +1]` | `OrderBookState` | `OrderBookState.observedAtMs` | healthy book, positive denominator |
| `signedImbalanceTop10` | same formula over ten levels                             | dimensionless, `[-1, +1]` | `OrderBookState` | `OrderBookState.observedAtMs` | healthy book, positive denominator |
| `bidDepthTop5Levels`   | number of available best bid levels, up to five          | level count               | `OrderBookState` | `OrderBookState.observedAtMs` | healthy non-empty book             |
| `askDepthTop5Levels`   | number of available best ask levels, up to five          | level count               | `OrderBookState` | `OrderBookState.observedAtMs` | healthy non-empty book             |
| `bidDepthTop10Levels`  | number of available best bid levels, up to ten           | level count               | `OrderBookState` | `OrderBookState.observedAtMs` | healthy non-empty book             |
| `askDepthTop10Levels`  | number of available best ask levels, up to ten           | level count               | `OrderBookState` | `OrderBookState.observedAtMs` | healthy non-empty book             |

Positive imbalance means more bid quantity than ask quantity. It is not named
or interpreted as bullish. An unhealthy book, missing side, invalid level, or
zero denominator returns `null` feature values with explicit health.

## AggTrade Flow Features

V1 uses the requested window represented by the supplied rolling-state flow
input. The calculator does not create a buffer or duplicate continuity logic.

| Name                | Meaning                                             | Unit                   | Source                                 | Timestamp       | Health prerequisite                        |
| ------------------- | --------------------------------------------------- | ---------------------- | -------------------------------------- | --------------- | ------------------------------------------ |
| `takerBuyVolume`    | buyer-initiated volume                              | base-asset quantity    | `RollingAggTradeBuffer.getTakerFlow()` | event watermark | complete, gap-free, not capacity-truncated |
| `takerSellVolume`   | seller-initiated volume                             | base-asset quantity    | same                                   | event watermark | same                                       |
| `netTakerVolume`    | buy volume minus sell volume                        | base-asset quantity    | same                                   | event watermark | same                                       |
| `tradeCount`        | trades in requested window                          | count                  | same                                   | event watermark | same                                       |
| `observedWindowMs`  | event-time span represented                         | milliseconds           | same                                   | event watermark | same                                       |
| `requestedWindowMs` | requested event-time window                         | milliseconds           | same                                   | event watermark | valid positive window                      |
| `coverageRatio`     | `clamp(observedWindowMs / requestedWindowMs, 0, 1)` | dimensionless `[0, 1]` | same                                   | event watermark | complete, gap-free, not truncated          |

An empty but complete and gap-free window is healthy and retains numeric zeroes;
an incomplete, gapped, or capacity-truncated window returns `null` values and
`UNAVAILABLE`. This prevents missing flow from being confused with zero flow.

## Candle Features

Returns use decimal units: `0.001` means `+0.1%` (`+10` bps). Only observations
with `status: CLOSED` are eligible. The latest causal closed candle is the
current close. Each target uses the latest candle at or before
`currentCloseTime - windowMs`; array position is never treated as elapsed time.

| Name       | Formula                                                                  | Unit           | Source                         | Timestamp                                                    | Health prerequisite       |
| ---------- | ------------------------------------------------------------------------ | -------------- | ------------------------------ | ------------------------------------------------------------ | ------------------------- |
| `return1m` | `(latestClose - closeAtOrBefore(latestCloseTime - 60000)) / targetClose` | decimal return | healthy `CandleSeriesSnapshot` | local `observedAtMs`; exchange boundary preserved separately | `HEALTHY`, closed history |
| `return3m` | same with `180000` ms                                                    | decimal return | same                           | same                                                         | same                      |
| `return5m` | same with `300000` ms                                                    | decimal return | same                           | same                                                         | same                      |

`GAPPED`, `ANOMALOUS`, `UNAVAILABLE`, and `STALE` series return null returns.
Open candles, missing target history, zero target prices, and future candles
cannot produce a numeric return. No interpolation is performed.

## Versioning And Causality

The exported schema constant and `schemaVersion: 1` are part of the contract.
Any formula, unit, level definition, window, or timestamp semantic change
requires a new schema version. Calculators are pure functions: they perform no
I/O, polling, subscriptions, lifecycle operations, persistence, logging, or
exchange mutation.
