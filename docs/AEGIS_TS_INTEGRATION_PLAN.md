# Aegis TS Integration Plan

## Runtime Modes

- `TRADING_MODE=AEGIS_SHADOW` is the default.
- `TRADING_MODE=AEGIS_TURBO_MICRO_LIVE` enables the micro-live gate path.

`AEGIS_LIVE_ENABLED` defaults to `false`. Live execution also requires `aegis.turbo.live_enabled=true` in the active YAML config.

## Phase 1 — Shadow Integration

The bot requests `/ml-v2/predict`, preserves Aegis metadata, and logs Safe/Turbo shadow observations. In `AEGIS_SHADOW` it returns before entry execution.

## Phase 2 — AegisMicroLiveGate

The gate decides whether a Turbo raw signal is eligible for micro-live. Initial limits:

- Uses `REGIMES.AEGIS_TURBO.entry_threshold` as the minimum Turbo score.
- Uses `REGIMES.AEGIS_TURBO.leverage` as the leverage cap.
- Uses `aegis.turbo.position_fraction_cap` as the maximum position fraction cap.
- The effective position fraction comes from Aegis API `aegis.turbo.raw.position_fraction`; the cap only limits it.
- SHORT disabled by default.
- Maximum trades, cooldown, daily loss, liquidity stress, and consecutive loss limits enforced.
- SL, TP, trailing, and max hold time come from `REGIMES.AEGIS_TURBO`.

## Phase 3 — Gate Dry-Run

`TradingService` evaluates the gate in runtime. Denied decisions log `aegis_micro_live_gate_denied`; allowed decisions remain dry-run unless live is explicitly enabled by both env and YAML.

## Phase 4 — Aegis Turbo Micro-Live Execution

The live path is implemented but off by default.

Live requires:

```bash
TRADING_MODE=AEGIS_TURBO_MICRO_LIVE
AEGIS_LIVE_ENABLED=1
```

And the active YAML must contain:

```yaml
aegis:
  turbo:
    enabled: true
    live_enabled: true
```

Execution behavior:

- Sets isolated margin.
- Sets leverage capped by `REGIMES.AEGIS_TURBO.leverage`.
- Uses `gate.positionFraction = min(raw.position_fraction, aegis.turbo.position_fraction_cap)`.
- Calculates entry margin as `wallet * (1 - fee_buffer_pct) * gate.positionFraction`.
- Opens market only after the gate allows.
- Places SL/TP brackets immediately.
- Validates brackets after entry.
- Closes the position immediately if required brackets fail.
- Stores `AEGIS_TURBO` metadata in state.

## Telegram Runtime Messages

Fecha: 2026-05-06.

Startup message:

- No longer includes the old fixed target (`$20 -> $500`), because that target is not useful for the live runtime state.
- Includes the current USDT wallet balance at boot as `Wallet Actual`.
- Includes compact `Balance Aprox.`, calculated as current available wallet balance plus active position margin plus open unrealized PnL. Example: `$500 available + $65 margin - $10 open PnL = ~$555`. The Telegram message only prints the final approximate total to stay short when multiple symbols are active. When Binance does not expose unrealized PnL, the bot approximates it from current ROE and entry margin.
- Shows leverage cap, real entry threshold, max hold time, circuit breaker state, trailing configuration, initial radar scan, and current position state.
- If there is an active position on restart, calculates displayed PnL from current ROE and entry margin instead of using wallet delta.
- Shows Binance TP/SL brackets with trigger price and ROE percentage.

Entry message:

- Uses the Phantom/Kamikaze-style compact format adapted as `AEGIS TURBO ENTRY`.
- Shows symbol, side, entry price, ETH size, margin, locked leverage, SL/TP price plus ROE percentage, trailing activation/callback, AI probabilities, Turbo score, votes, reason, wallet, and threshold.
- Entry wallet is the live `exchange.getUSDTBalance()` value used by the sizing flow.

Exit message:

- Uses the Phantom/Kamikaze-style close format adapted as `AEGIS TURBO EXIT`.
- Reports entry price, exit price, final ROE, PnL, margin, duration, MFE/MAE, and current balance.
- Exit PnL is derived from ROE and margin when available.
- Reason is normalized into explicit close categories: stop loss, take profit, trailing/callback, break even, time limit, IA, or risk-control fallback.

## Runtime Sizing Source

Fecha: 2026-05-06.

`raw.position_fraction` is not calculated in this TypeScript bot. It is produced by the Python Aegis API and consumed here as part of the Turbo metadata.

Current contract:

```text
Aegis Python:
  aegis_alpha/configs/turbo.yaml
  -> sizing bucket by turbo_score
  -> aegis.turbo.raw.position_fraction

TypeScript bot:
  -> gate.positionFraction = min(raw.position_fraction, position_fraction_cap)
  -> margin = wallet * (1 - fee_buffer_pct) * gate.positionFraction
  -> notional = margin * leverage
```

Operational meaning:

- `SYMBOLS.ETHUSDT: 1.0` and `TRADING.capital_usage_default: 1.0` do not force full-wallet Aegis Turbo entries.
- `aegis.turbo.position_fraction_cap: 1.0` means "allow up to 100% if Aegis asks for it"; it does not rewrite Aegis sizing.
- To change the normal/premium fraction, edit `aegis_alpha/configs/turbo.yaml` in the parent `trading_system` repo.
- After the Python service has the hot-reload code loaded once, future YAML edits do not require a Python restart.

Documentation rule:

- Any change to Aegis sizing, caps, live gates, entry margin math, env variables, YAML contracts, or recovery procedures must be recorded here and in `aegis_alpha/docs/AEGIS_ALPHA_WHITEPAPER.md`.

Recommended first live validation:

- `max_trades_per_day: 1`
- `allow_short: false`
- Small wallet allocation only.
- Confirm SL/TP on Binance immediately.
- Return to `TRADING_MODE=AEGIS_SHADOW` after the test.

Rollback:

```bash
TRADING_MODE=AEGIS_SHADOW
AEGIS_LIVE_ENABLED=0
pm2 restart 01-Trading-Bot --update-env
```

## Validation

```bash
npm run build
npx vitest run src/domain/services/AegisMicroLiveGate.test.ts
npx vitest run src/app/services/AegisMLService.test.ts src/app/services/TradingService.aegis.test.ts src/app/services/TradingService.aegis-gate.test.ts src/app/services/TradingService.aegis-live.test.ts
```
