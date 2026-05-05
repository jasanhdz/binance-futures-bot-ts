# Aegis TS Integration Plan

## Frozen Phantom Baseline

Phantom/Kamikaze is frozen locally in:

- Branch: `archive/phantom-v33-kamikaze`
- Tag: `phantom-v33-kamikaze-freeze-2026-05-05`

The TypeScript integration work starts from `feature/aegis-ts-integration`.

## Runtime Modes

- `TRADING_MODE=AEGIS_SHADOW` is the default.
- `TRADING_MODE=PHANTOM_LEGACY` keeps the existing Phantom/Kamikaze path.
- `TRADING_MODE=AEGIS_TURBO_MICRO_LIVE` is reserved for a later phase.

`AEGIS_LIVE_ENABLED` defaults to `false`. Phase 1 never opens live entries from Aegis.

## Phase 1 Scope

This phase adds an Aegis API adapter and logs Aegis Safe/Turbo shadow observations from `/ml-v2/predict`.

In `AEGIS_SHADOW`:

- The bot requests the full Aegis prediction.
- The bot logs Safe and Turbo raw/gated state.
- The bot returns before Phantom `shouldEnter`, KAMIKAZE sizing, Phantom shadow positions, or Binance entry execution.

## Phase 2 — AegisMicroLiveGate

This phase adds a pure TypeScript decision gate for Aegis Turbo micro-live candidates. It does not open orders, call Binance execution, or connect entry execution into `TradingService`.

The gate only answers whether a Turbo raw signal could qualify for a future micro-live entry. Live eligibility requires both:

- `TRADING_MODE=AEGIS_TURBO_MICRO_LIVE`
- `AEGIS_LIVE_ENABLED=1`

Initial risk limits:

- Leverage is capped at 15x, even if Turbo suggests more.
- Position fraction is capped at 0.10, even if Turbo suggests more.
- SHORT is disabled by default unless `AEGIS_TURBO_ALLOW_SHORT=1`.
- Maximum 2 trades per day.
- 2 consecutive losses block new entries.
- Daily loss of 10% blocks new entries.
- Cooldown is 15 minutes after exit.
- Liquidity stress above 0.70 blocks new entries.

Python production flags such as `execute=false` or `production_allowed=false` are recorded in the decision via gated metadata, but do not block this TS gate when TS is explicitly configured for micro-live. Actual order execution remains for a later phase.

## Phase 3 — TradingService Gate Dry-Run

This phase connects `AegisMicroLiveGate` into `TradingService` only for `TRADING_MODE=AEGIS_TURBO_MICRO_LIVE`.

Runtime behavior:

- The bot fetches the full Aegis-compatible signal.
- The bot logs `aegis_scan`.
- The bot evaluates the micro-live gate.
- Denied decisions log `aegis_micro_live_gate_denied`.
- Allowed decisions log `aegis_micro_live_gate_allowed_dry_run`.

Allowed decisions are still dry-run only. Phase 3 intentionally does not call Binance execution, does not call `marketOpen`, does not set leverage, does not place stop or take-profit orders, and does not write real position state. This phase exists to validate wiring and real Aegis Turbo signals before entry plumbing is considered.

## Validation

```bash
npm run build
TRADING_MODE=AEGIS_SHADOW npm run dev:prod
npx vitest run src/domain/services/AegisMicroLiveGate.test.ts
npx vitest run src/app/services/AegisMLService.test.ts src/app/services/TradingService.aegis.test.ts src/domain/services/AegisMicroLiveGate.test.ts src/app/services/TradingService.aegis-gate.test.ts
```

## Next Phase

Add controlled micro-live entry plumbing only after dry-run logs and shadow metrics justify it.
