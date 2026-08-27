# MICRO_BURST_V1 M2 — Operational Shadow Report

Commit: pending
Branch: `work/micro-burst-rider-v1-20260826`

## Verdict

**MICRO_BURST_V1_M2_OPERATIONAL_SHADOW_READY**

## 1. Scope

M2 wires the Micro Burst shadow evaluation into the live bot runtime. The strategy receives real market data, evaluates continuously, and produces structured shadow telemetry — but **cannot open, close, or modify any exchange position**.

## 2. New Components

| Component                 | File                         | Purpose                                                            |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `MicroBurstRuntime`       | `MicroBurstRuntime.ts`       | Application-layer orchestrator: lifecycle, evaluation loop, health |
| `MicroBurstSignalJournal` | `MicroBurstSignalJournal.ts` | Append-only JSONL persistence for unique ENTRY_INTENT signals      |

## 3. Modified Components

| Component                                | Change                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `Exchange` port                          | Added optional `subscribeToAggTrades`, `getDepthSnapshot`                               |
| `BinanceAdapter`                         | Implemented `subscribeToAggTrades`, `getDepthSnapshot`                                  |
| `TradingService`                         | Creates/starts/stops `MicroBurstRuntime` when config enables SHADOW                     |
| `MicroBurstIdentity`                     | Shadow authority enabled, version bumped to `0.3.0-operational-shadow`                  |
| `MicroBurstContextBuilder`               | Added `AggTradeFlowProvider` interface; context includes `aggTradeFlow`                 |
| `MicroBurstTypes`                        | `MicroBurstContext` extended with optional `aggTradeFlow`                               |
| `MicroBurstShadowEvaluator`              | Diagnostics include aggTrade, referencePriceSource, btcAcceleration, temporal detection |
| `MicroBurstM1Audit.test.ts`              | Updated for M2: SHADOW=true, application-layer firewall tests                           |
| `MicroBurstArchitecture.test.ts`         | Updated for M2: SHADOW=true                                                             |
| `original-operational-semantics.test.ts` | Updated digests for modified Exchange/BinanceAdapter/TradingService                     |

## 4. Architecture

```
TradingService.start()
  └─ MicroBurstRuntime.start()
       ├─ BtcMicroContextProvider.start()  (shared BTC stream)
       ├─ SynchronizedOrderBook per symbol (depth sync)
       ├─ MicroBurstAggTradeBuffer per symbol (aggTrade streaming)
       ├─ MicroBurstReferencePriceProvider per symbol (mark price / midpoint)
       ├─ MicroBurstShadowEvaluator (orchestrates evaluation)
       ├─ Evaluation loop (configurable interval, default 5s)
       ├─ Health reporting (60s interval)
       └─ MicroBurstSignalJournal (JSONL persistence)

TradingService.stop()
  └─ MicroBurstRuntime.stop()
       ├─ Clear evaluation timer
       ├─ Clear health timer
       ├─ Stop all order books
       ├─ Clear aggTrade buffers
       ├─ Stop BTC provider
       └─ Flush journal
```

## 5. Startup Sequence

1. `TradingService.start()` reads `micro_burst` config
2. If `enabled=true` AND `mode=SHADOW`:
   - Creates `MicroBurstRuntime` with exchange, logger, clock, strategy router
   - Calls `runtime.start()`
3. Runtime initializes:
   - BTC context provider (shared across all symbols)
   - Per-symbol: order book, aggTrade buffer, reference price provider
   - Shadow evaluator with context builder deps
   - Evaluation loop at configured interval
   - Health reporting at 60s interval
4. If `mode=LIVE`: throws `MICRO_BURST_V1_LIVE_NOT_AUTHORIZED` (fail-closed)

## 6. Evaluation Loop

- Interval: configurable `evaluation_interval_ms` (default 5000ms)
- Iterates over enabled symbols
- Per-symbol in-flight guard: prevents overlapping evaluations
- Each evaluation:
  1. `MicroBurstShadowEvaluator.evaluate({ symbol, snapshotAtMs })`
  2. Builds context from real providers (candles, book, BTC, reference price, aggTrade)
  3. Routes through `StrategyRouter.evaluate('MICRO_BURST_V1')`
  4. Produces structured telemetry
  5. If `wouldEnter && !duplicateSuppressed`: appends to signal journal

## 7. Config Integration

Config loaded from YAML (`micro_burst` section) or environment variables:

```yaml
micro_burst:
  enabled: true
  mode: SHADOW
  symbols:
    ETHUSDT:
      enabled: true
    SOLUSDT:
      enabled: true
    BNBUSDT:
      enabled: true
```

Environment fallback:

```
MICRO_BURST_V1_ENABLED=true
MICRO_BURST_V1_MODE=SHADOW
MICRO_BURST_V1_SYMBOLS=ETHUSDT,SOLUSDT,BNBUSDT
```

## 8. Shadow Authority

- `MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED = true` — can evaluate and log decisions
- `MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = false` — cannot execute
- `hasLiveAuthority()` returns `false` in all M2 scenarios
- `freezeState` remains `DRAFT`

## 9. Exchange Mutation Firewall

Static audit confirms:

- No `marketOpen`, `placeStopClose`, `placeTpClose`, `closeSideMarketSafe` in domain production code
- No `SharedStrategyExecutionService.execute()` in MicroBurstRuntime or MicroBurstSignalJournal
- Runtime test: 100 evaluations produce zero exchange mutations
- `liveExecution: false` hardcoded in all results

## 10. Signal Journal

Append-only JSONL at `logs/micro-burst/shadow-signals/YYYY-MM-DD-{ts}.jsonl`:

- Only unique `ENTRY_INTENT` signals (no duplicates, no NO_TRADE)
- Contains: strategy metadata, symbol, side, prices, momentum, book, aggTrade, BTC, decision
- Rotates after 10,000 entries per file
- No API credentials stored
- Flush on runtime stop

## 11. Health Reporting

Periodic `MICRO_BURST_SHADOW_HEALTH` log every 60s:

```
symbols=3 healthyBooks=3 btcHealthy=true
evaluations=... uniqueSignals=... duplicates=...
invalidContexts=... resyncs=... liveExecution=false
```

Per-symbol health available via `runtime.getSymbolHealth(symbol)`.

## 12. Failure Isolation

- Per-symbol book failure → only that symbol goes UNSYNCED/ANOMALOUS
- BTC provider failure → all symbols fail closed (no BTC context)
- Evaluation error → logged, returns NO_TRADE, does not crash runtime
- Runtime error → does not affect Aegis/Momentum strategies
- TradingService catches startup errors gracefully

## 13. AggTrade Semantics

- `isBuyerMaker=true` → Taker was SELL (maker was buyer)
- `isBuyerMaker=false` → Taker was BUY (aggressive buying)
- `buyTakerVolume` = sum of quantities where `isBuyerMaker=false`
- `sellTakerVolume` = sum of quantities where `isBuyerMaker=true`
- `netTakerFlow` = buyTakerVolume - sellTakerVolume

## 14. Known Limitations

- Config section `micro_burst` must be added to `regime_config.live.yaml` manually
- BTC stream uses REST polling (not WebSocket) for candle data
- Evaluation interval is fixed at startup (not dynamically adjustable)
- No real-time reconnection for depth stream gaps beyond resync attempts

## 15. Blockers for M3

- Tune S/R detection parameters for real market conditions
- Tune momentum thresholds and leverage tiers
- Validate temporal absorption/sweep thresholds with real data
- Tune BTC conflict threshold
- Backtest signal quality with real shadow journal data

## 16. Blockers for LIVE

- Complete M3 tuning and validation
- Freeze strategy identity and config hashes
- Explicit approval after monitoring shadow performance
- Add hard-cap 1% position fraction
- Production paper-trading validation
