# Aegis Config Inheritance

`regime_config.live.yaml` supports small, explicit inheritance blocks to keep live
configuration readable without changing the effective runtime config.

## Order

For every inherited block, the resolution order is:

```text
defaults < profile < symbol override
```

Profiles and defaults never create a symbol, side, or strategy by themselves.
The symbol or side must still be present in the explicit entries block, and
Momentum Ride sides still require `enabled: true`.

## Aegis Symbols

Use `symbols.defaults` for fields shared by all configured symbols and
`symbols.entries` for the actual symbol list:

```yaml
symbols:
  defaults:
    enabled: true
    mode: LIVE
  entries:
    BTCUSDT: {}
    ETHUSDT: {}
```

Legacy syntax still works:

```yaml
symbols:
  BTCUSDT:
    enabled: true
    mode: LIVE
```

## Regime Profiles

`REGIME_PROFILES` defines reusable partial overrides per regime. A symbol can
reference a profile under `SYMBOL_OVERRIDES`.

```yaml
REGIME_PROFILES:
  AEGIS_TURBO:
    reduced_15x:
      leverage: 15

SYMBOL_OVERRIDES:
  BNBUSDT:
    AEGIS_TURBO:
      profile: reduced_15x
```

Direct symbol values override the profile:

```yaml
SYMBOL_OVERRIDES:
  BNBUSDT:
    AEGIS_TURBO:
      profile: reduced_15x
      entry_threshold: 0.62
```

## Momentum Ride

Momentum Ride uses side-specific defaults plus profiles:

```yaml
aegis:
  momentum_ride:
    defaults:
      long:
        position_fraction: 0.02
    profiles:
      major_high_confidence_long:
        leverage: 50
    symbols:
      BTCUSDT:
        long:
          enabled: true
          profile: major_high_confidence_long
```

The Momentum risk profile is only applied when `finalStrategy=momentum_ride`.
Aegis Turbo keeps its normal sizing and leverage path.

## Verification

Generate the deterministic effective config:

```bash
npm run dump:effective-config -- --out /tmp/aegis_effective.json
```

Before committing a DRY refactor, compare the effective JSON before and after.
Trading-relevant fields such as leverage, thresholds, risk mode, symbols, and
Momentum Ride profiles must remain identical unless the change is intentional.

## Live YAML Rule

Do not repeat a value in a symbol override when it is already inherited from the
base regime or profile. Keep each symbol block to the minimum needed to express
the real difference.
