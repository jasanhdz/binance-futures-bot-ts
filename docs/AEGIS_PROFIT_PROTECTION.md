# Aegis Profit Protection

Profit Protection sits between break-even and trailing.

It does not change entries, leverage, sizing, EventRisk, EntryQuality, DecisionBrain, Python models, or market-open behavior. It only handles open Aegis Turbo positions after the trade has already moved into profit.

## Layers

`BREAK_EVEN`

ProfitGuardian emits `MOVE_SL_BE` after `be_roe`. The bot moves the close stop near entry plus the configured offset. If the stop would trigger immediately or does not improve the old stop, it is skipped and the old SL remains active.

`PROTECT_PROFIT`

Exit Eye emits `PROTECT_PROFIT` when profitable momentum decays before trailing has activated. The bot locks part of the peak ROE by moving the close stop:

```text
targetProtectedRoe = max(min_locked_roe, peakRoe - protect_giveback_roe)
```

If current ROE has already fallen below that target, the bot caps the stop behind the mark with `immediate_trigger_buffer_pct` so it does not self-trigger.

`TRAILING`

Trailing remains unchanged. It still activates from `trailing_activation_roe` and uses the existing callback/ATR logic.

## Config

```yaml
aegis:
  profit_protection:
    enabled: true
    protect_profit_enabled: true
    min_peak_roe_to_protect: 0.08
    protect_giveback_roe: 0.05
    min_locked_roe: 0.01
    be_offset_pct: 0.003
    immediate_trigger_buffer_pct: 0.001
```

Example:

```text
ADAUSDT LONG
Peak ROE: +14.5%
Current ROE: +8.8%
Target protected ROE: +9.5%
```

Because +9.5% would be above the current mark, the bot caps the stop below the mark and still protects profit instead of doing nothing.

## Safe Stop Move

`safeMoveCloseStop`:

- validates that the position is still active
- validates side, quantity, entry price and leverage
- checks that the new stop improves the previous stop
- checks immediate-trigger risk
- places the new stop first
- cancels only old stop orders by id
- leaves TP orders untouched
- verifies that at least one SL and TP remain visible

If the exchange rejects the new stop, the old stop is not canceled and the state is not marked executed.

## Events

- `BREAK_EVEN_EXECUTED`
- `PROTECT_PROFIT_EXECUTED`
- `AEGIS_EXIT_EYE_PROTECT_PROFIT_EXECUTED`
- `PROTECT_PROFIT_STOP_MOVED`
- `PROTECT_PROFIT_SKIPPED`
- `SAFE_STOP_MOVE_SKIPPED`
- `SAFE_STOP_MOVE_FAILED`
- `SL_MOVED`

Skip reasons:

- `immediate_trigger_risk`
- `stop_not_improved`
- `missing_position`
- `missing_entry`
- `missing_leverage`
- `missing_quantity`
- `exchange_error`

Telegram is sent only when protection is executed. Skips are logged unless the exchange fails, in which case the bot sends a warning alert.
