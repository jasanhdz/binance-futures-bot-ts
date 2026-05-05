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

## Validation

```bash
npm run build
TRADING_MODE=AEGIS_SHADOW npm run dev:prod
```

## Next Phase

Add `AegisMicroLiveGate` and controlled micro-live entry plumbing only after shadow metrics justify it.
