# Micro Opportunity Feature Contract V1

**Schema:** `MICRO_OPPORTUNITY_FEATURE_V1`  
**Source of ordered feature names/hash:** `src/strategies/micro-burst/research/MicroOpportunityFeatureVector.ts`  
**Rule:** every feature is causal and must be observable no later than `sampledAtMs`. Missing/unqualified live observations are represented as `null` or explicit quality flags; they are never silently replaced with future values.

## Fast price dynamics

| Feature | Unit | Source/timestamp | Missing semantics |
|---|---|---|---|
| `priceReturn250msBps` | bps | aggTrade event-time, latest vs last qualified trade at/before T-250ms | `null` if no sufficiently fresh anchor |
| `priceReturn1sBps` | bps | aggTrade event-time | `null` if no qualified anchor |
| `priceReturn3sBps` | bps | aggTrade event-time | `null` if no qualified anchor |
| `priceReturn5sBps` | bps | aggTrade event-time | `null` if no qualified anchor |
| `priceReturn10sBps` | bps | aggTrade event-time | `null` if no qualified anchor |
| `velocityBpsPerSecond` | bps/s | 1 s causal return | `null` when 1 s return unavailable |
| `accelerationBpsPerSecond2` | bps/s² | difference between 1 s and 3 s average velocities over two seconds | `null` if either velocity unavailable |
| `tradeIntensityPerSecond` | trades/s | aggTrades ending at latest causal trade | `null` with no trade state |

## Taker flow

| Feature | Unit | Source/timestamp | Missing semantics |
|---|---|---|---|
| `takerImbalance` | [-1,1] | causal 5 s aggTrade window; buyer-maker=false is aggressive buy | `null` when total qualified taker volume is zero |
| `flowGapFree` | 0/1 | RollingAggTradeBuffer continuity | 0 blocks qualified use |
| `flowWindowComplete` | 0/1 | 10 s continuity/coverage window | 0 means insufficient coverage |
| `flowCapacityTruncated` | 0/1 | RollingAggTradeBuffer | 1 means incomplete evidence |

## Order book / microstructure

| Feature | Unit | Source/timestamp | Missing semantics |
|---|---|---|---|
| `spreadBps` | bps | synchronized order book at/before sample | `null` without valid bid/ask |
| `signedBookImbalance` | [-1,1] | synchronized depth | `null` when unavailable |
| `bookImbalanceSlope` | normalized slope | temporal synchronized depth observations | `null` without temporal history |
| `temporalSweepDetected` | 0/1 | temporal book analyzer | `null` when book unavailable |
| `temporalAbsorptionDetected` | 0/1 | temporal book analyzer | `null` when book unavailable |
| `bookAgeMs` | ms | sample local time - book observed time | `null` when unavailable; negative age is invalid |

## Stable Micro slow context

| Feature | Unit | Source/timestamp | Missing semantics |
|---|---|---|---|
| `momentumStrength` | normalized | closed 1m/3m/5m causal context | required by valid slow context |
| `continuationScore` | normalized | stable Micro momentum analyzer | required |
| `momentumSlope1m` | decimal return/bar | closed candles | required |
| `momentumSlope3m` | decimal return/bar | closed candles | required |
| `momentumSlope5m` | decimal return/bar | closed candles | required |
| `bodyStrength` | normalized | closed candles | required |
| `wickRejectionUpper` | normalized | closed candles | required |
| `wickRejectionLower` | normalized | closed candles | required |
| `volumeExpansion` | 0/1 | closed candles | required |
| `candleSequenceQuality` | normalized | closed candles | required |
| `structuralPosition` | categorical | causally available S/R | required |
| `microRegime` | categorical | closed 5m context | required |
| `corridorWidthBps` | bps | causally available support/resistance | may be non-finite when structure unavailable; such rows are audited before model fitting |

## Live structural distances

`distanceToSupportBps` and `distanceToResistanceBps` are recomputed from the fast live reference price against S/R levels that were already causally available in the slow state. They are `null` if the corresponding level or live price is unavailable.

## BTC context

`btcRet1mBps`, `btcRet3mBps`, `btcRet5mBps`, and `btcAccelerationBps` convert the existing decimal-return BTC context to bps. `btcConflict` is 0/1. All are `null` when BTC context is unavailable.

## Data-quality metadata

`tradeAgeMs`, `bookAgeMs`, `flowGapFree`, `flowWindowComplete`, and `flowCapacityTruncated` are included explicitly so the model/research pipeline can distinguish missing or degraded evidence rather than impute it invisibly.

## Explicit exclusions from model features

The sample envelope persists the frozen stable-Micro decision (`ENTRY_INTENT` / `NO_TRADE`), proposed side, reason, confidence, and candidate ID as **research metadata only**. These fields are not members of `OpportunityFeatureVectorV1` and therefore cannot let the model simply learn the current policy label.

Future outcomes, MFE, MAE, barrier results, final returns, costs, and any post-T0 data are labels only and are forbidden from the feature vector.
