# SUI SR Scout Observation Runtime

The Scout is an isolated process. Its effective universe is exactly `BTCUSDT`
(market context) and `SUIUSDT` (the sole candidate). It does not construct a
`TradingService` or start Aegis, Momentum Ride, MicroBurst, or legacy scanners.

## Run in observation mode

```bash
SUI_SR_SCOUT_ENABLED=1 \
SUI_SR_SCOUT_EXECUTION_MODE=OBSERVE \
SUI_SR_SCOUT_LIVE_ENABLED=0 \
SUI_SR_SCOUT_KILL_SWITCH=1 \
ts-node src/scouts/sui-sr-scout/main.ts
```

The entrypoint rejects `LIVE_CANARY` in this phase. It supplies no order port
to the coordinator, and observation decisions never invoke the executor.

## Market readiness

Before the runtime becomes ready it loads 240 historical 1-minute candles and
80 historical 3-minute candles for each subscribed symbol. The historical
state seeds ATR and pivot/zone detection. A failed or incomplete warmup leaves
the process in `NOT_READY`; candidate evaluation is skipped.

Live data uses only existing Binance adapter subscriptions for each symbol:

- 1-minute kline updates;
- aggregate trades;
- USD-M depth diffs at 100 ms.

The runtime retains exchange and local receipt timestamps. It records and
blocks on depth/aggregate-trade sequence gaps, reconnections, stale feeds, and
out-of-order events. Funding and mark price are read during warmup. Open
interest is explicitly reported as unsupported rather than represented as zero.

## Read-only reconciliation

Every ten seconds the process reads SUI position and close-order state. Unknown
account state, multiple positions, a position without a confirmed stop, or an
account-read error is fail-closed. This phase performs no account mutation.

## Observation soak

Run a 20-30 minute public-data soak without PM2:

```bash
SUI_SR_SCOUT_SOAK_MINUTES=25 npm run sui-sr-scout:observe-soak
```

The command refuses non-observe settings and writes JSON and Markdown reports
under `data/sui-sr-scout/soaks/`. Reports include warmup status, per-symbol
gaps/reconnections/event freshness, levels, decisions, journal count, and
clean shutdown status.
