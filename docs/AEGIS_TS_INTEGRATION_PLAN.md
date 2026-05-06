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
- Position fraction capped at 0.10.
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
- Uses position fraction capped at 0.10.
- Opens market only after the gate allows.
- Places SL/TP brackets immediately.
- Validates brackets after entry.
- Closes the position immediately if required brackets fail.
- Stores `AEGIS_TURBO` metadata in state.

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
