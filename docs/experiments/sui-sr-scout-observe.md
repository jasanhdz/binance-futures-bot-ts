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

Observation mode supplies no order port to the coordinator, and observation
decisions never invoke the executor.

## Live canary (explicit opt-in)

`LIVE_CANARY` remains disabled by default. It is the only mode that receives
the narrow SUI order port; BTC is always context-only and cannot be ordered.
Do not run this command until an owner explicitly authorizes a real canary:

```bash
SUI_SR_SCOUT_EXECUTION_MODE=LIVE_CANARY \
SUI_SR_SCOUT_LIVE_ENABLED=1 \
SUI_SR_SCOUT_SYMBOL=SUIUSDT \
SUI_SR_SCOUT_CONTEXT_SYMBOL=BTCUSDT \
SUI_SR_SCOUT_MAX_OPEN_POSITIONS=1 \
SUI_SR_SCOUT_MAX_LEVERAGE=10 \
SUI_SR_SCOUT_MAX_RISK_PER_TRADE_BPS=50 \
SUI_SR_SCOUT_MAX_DAILY_LOSS_BPS=150 \
SUI_SR_SCOUT_COOLDOWN_AFTER_STOP_MS=10800000 \
SUI_SR_SCOUT_KILL_SWITCH=0 \
ts-node src/scouts/sui-sr-scout/main.ts
```

The runner rejects missing mandatory limits. It sizes from fixed available
margin and the S/R-derived stop, requires a structural target net of at least
1.5R after configured costs, confirms a reduce-only stop before take profit,
and emergency-closes plus locks further entries on protection failure. The
default time stop is 15 minutes.

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
