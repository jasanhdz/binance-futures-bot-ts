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

- Fecha: 2026-05-07.
- Uses a compact professional `AEGIS TURBO ENTRY` format without Markdown emphasis, backticks, or underscores in the rendered dynamic fields.
- Does not show legacy ML probabilities (`Long`, `Short`, `Idle`, `Close`) because Aegis Turbo entries are driven by Turbo gate metrics, not the legacy probability section.
- Shows symbol, side, entry price, leverage, base-asset size, margin, account balances, Turbo score/threshold, votes, formatted reason, SL/TP, trailing status, callback when enabled, and `Brackets confirmados`.
- `Score: X% / Y%` means current `gate.turboScore` versus the effective entry threshold. The threshold is read from `REGIMES.AEGIS_TURBO.entry_threshold` through `configManager.getRegimeConfig('AEGIS_TURBO', symbol)` and the same `getAegisTurboGateConfig(symbol).minScore` path used by the real gate.
- Reason formatting is centralized in `src/app/services/formatAegisTurboEntryMessage.ts`. Known compact reasons such as `rawrecentlongagreement2of3` render as `Acuerdo LONG reciente 2/3`; unknown reasons are normalized into readable text.
- Entry wallet still comes from the live `exchange.getUSDTBalance()` value used by sizing. If the exchange adapter exposes `getUSDTAccountSnapshot()`, the message also shows:
  - `Wallet`: total USDT wallet balance when available, otherwise sizing wallet fallback.
  - `Equity total`: wallet plus total unrealized PnL when Binance exposes both values; otherwise `N/D`.
  - `Disponible`: available USDT balance when exposed by Binance; otherwise `N/D`.
- Binance snapshot source is `futuresAccountInfo()` via `BinanceExchange.getUSDTAccountSnapshot()`. The method is optional on the `Exchange` port, so mocks and non-Binance adapters can omit it without changing entry execution.

Example:

```text
🔥 AEGIS TURBO ENTRY

ETHUSDT | 📈 LONG
Entrada: $3000.00 | Lev: 20x
Tamaño: 0.010 ETH | Margen: $2.00 USDT

💰 CUENTA
Wallet: $575.62
Equity total: $579.12
Disponible: $421.42

🧠 TURBO SIGNAL
Score: 65.1% / 60.0%
Votes: L=2 | S=0 | N=1
Motivo: Acuerdo LONG reciente 2/3

🛡️ RIESGO / BRACKETS
SL: $2977.50 (-40.0% ROE)
TP: $3037.50 (+50.0% ROE)
Trailing: ON desde +15.0% ROE
Callback: +8.0% ROE

✅ Brackets confirmados
```

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

## Aegis Turbo History And Analysis

Fecha: 2026-05-07.

`TradingService` now writes non-blocking Aegis Turbo history records through `src/infra/logging/AegisTurboHistoryLogger.ts`. Logging failures are downgraded to warnings and must not block trading, bracket placement, emergency closes, or exits.

Default log directory:

```text
logs/aegis/
```

Daily JSONL files:

- `turbo_signals_YYYY-MM-DD.jsonl`: raw/gated/final action, Turbo score, votes, freshness, gate decision, leverage, position fraction, risk config, execution flag, and trade id.
- `turbo_trades_YYYY-MM-DD.jsonl`: open/close lifecycle records with side, entry/exit, quantity, leverage, margin/notional estimates, Turbo score, votes, ROE, PnL, MFE/MAE, duration, bracket confirmation, and status.
- `turbo_trade_events_YYYY-MM-DD.jsonl`: gate allowed/denied, order submitted, position confirmed, brackets confirmed/recreated/missing, trailing and break-even events, emergency close attempts/results, and trade closed events.
- `account_snapshots_YYYY-MM-DD.jsonl`: wallet, available balance, unrealized PnL, daily PnL, trade counters, open-position count, margin/notional exposure, and per-symbol snapshot metadata.

Generated identifiers:

- `AEGIS-SIGNAL-{SYMBOL}-{TIMESTAMP}` for signal observations.
- `AEGIS-TURBO-{SYMBOL}-{TIMESTAMP}` for trade lifecycle records.
- `AEGIS-SESSION-{YYYYMMDD}` for portfolio session grouping.

Analysis command:

```bash
npm run analyze:aegis-turbo -- --date 2026-05-07 --symbol ETHUSDT
```

The analyzer reads the JSONL history and writes reports under `reports/` by default. Reports include summary PnL, win rate, profit factor, score buckets, exit reasons, symbol/side breakdowns, portfolio snapshots, warnings for corrupted JSONL lines, and both JSON and Markdown output.

Operational notes:

- The analyzer can filter by `--symbol`, analyze all symbols, or use date ranges depending on CLI options.
- Account equity in reports depends on available account snapshots. Missing equity fields are left absent/null rather than invented.
- The `analyze:aegis-turbo` npm script is the supported entry point for local review.

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
npm test
npx vitest run src/domain/services/AegisMicroLiveGate.test.ts
npx vitest run src/app/services/AegisMLService.test.ts src/app/services/TradingService.aegis.test.ts src/app/services/TradingService.aegis-gate.test.ts src/app/services/TradingService.aegis-live.test.ts
```

Latest local validation for the 2026-05-07 Telegram/account/history update:

- `npm run build`: passed.
- `npm test`: passed, 72 tests across 11 files.
