# Aegis Exit Eye v0.2

Aegis Exit Eye is a profit-protection layer for open Aegis Turbo positions. It watches the current Aegis Turbo signal while a trade is already open and detects momentum loss after the trade has already been in profit.

It does not replace SL, TP, trailing, break-even, brackets, or the existing risk manager. Those controls still own loss protection and mechanical exits. Exit Eye is only allowed to react when the trade is profitable and has already reached a minimum peak ROE.

## Problem

Some Aegis Turbo entries moved into profit, then the live Aegis signal shifted from the original direction to HOLD or the opposite side. The existing trailing layer sometimes closed later, after a large giveback.

Example:

```text
LINKUSDT LONG enters well
ROE peaks at +27.9%
Aegis shifts LONG -> HOLD -> SHORT
Trailing closes later after profit giveback
```

Exit Eye records or acts on that momentum decay earlier.

## ProfitGuardian Break-Even

`ProfitGuardian` owns the mechanical profit guards before Exit Eye acts. It can emit `MOVE_SL_BE` once peak ROE reaches `REGIMES.AEGIS_TURBO.be_roe`; `TradingService` executes that action by replacing the stop-loss close order near entry, records `BREAK_EVEN_EXECUTED` and `SL_MOVED`, and keeps the take-profit order intact.

Live `be_roe` comes from the merged YAML/config path used by `configManager.getGuardianConfig('AEGIS_TURBO', symbol)`. If YAML omits it, the safe domain/config fallback is `0.10`. The live YAML currently sets:

```yaml
REGIMES:
  AEGIS_TURBO:
    be_roe: 0.08
```

The layers have different jobs:

- Break-even protects near entry before trailing is eligible.
- ProtectProfit locks part of an existing gain when Exit Eye detects momentum decay before trailing is eligible.
- Trailing captures larger gains after `trailing_activation_roe`.
- Exit Eye detects profitable momentum decay from the live Aegis signal.

## Profit Protection Hotfix v1

`aegis.profit_protection` controls the safe stop move used by Exit Eye:

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

For `PROTECT_PROFIT`, the first target is:

```text
protectedRoe = max(min_locked_roe, peakRoe - protect_giveback_roe)
```

If that target would place the stop beyond the current mark and trigger immediately, the bot caps the stop to a safe price behind the mark using `immediate_trigger_buffer_pct`. If the capped stop still does not improve the previous stop, or still has immediate-trigger risk, the move is skipped and the existing SL remains untouched.

Safety rules:

- validates active position, side, quantity, entry and leverage
- checks immediate trigger risk before touching the old stop
- places the new stop before canceling the old stop
- cancels only previous stop orders by id
- does not cancel TP
- logs a bracket verification warning if SL or TP cannot be seen after the move
- does not mark protection executed when exchange placement fails

Events:

- `AEGIS_EXIT_EYE_PROTECT_PROFIT`
- `AEGIS_EXIT_EYE_PROTECT_PROFIT_EXECUTED`
- `AEGIS_EXIT_EYE_PROTECT_PROFIT_SKIPPED`
- `PROTECT_PROFIT_EXECUTED`
- `PROTECT_PROFIT_STOP_MOVED`
- `PROTECT_PROFIT_SKIPPED`
- `SAFE_STOP_MOVE_SKIPPED`
- `SAFE_STOP_MOVE_FAILED`
- `SL_MOVED`

## Modes

`OFF`

Disabled. No signal checks, no logs, no action.

`SHADOW`

Default live config mode. Exit Eye logs what it would have done and can send a compact Telegram alert. It never moves stops and never closes positions.

`PROTECT`

Exit Eye can request real profit protection. `TradingService` calculates a protected stop, calls `safeMoveCloseStop`, places the new reduce-only close stop first, then cancels only the previous stop orders. TP orders are not canceled.

The old v0.1 skip reason `protect_not_available_without_safe_stop_move_helper` should no longer appear for live `PROTECT_PROFIT` decisions.

`CLOSE`

Exit Eye may close a profitable position on strong opposite signal. It may also close on neutral momentum decay only when `close_on_neutral_decay=true` is explicitly enabled in YAML. It never closes losing positions.

## Rules

Neutral momentum decay:

```text
current ROE >= min_roe_to_protect
peak ROE >= min_peak_roe_to_protect
peak - current >= min_giveback_from_peak_roe
current Turbo action no longer supports the original side
neutral votes >= neutral_votes_to_protect
consecutive neutral observations >= require_consecutive_neutral
```

Neutral momentum decay close, disabled by default:

```text
mode == CLOSE
close_on_neutral_decay == true
current ROE >= min_roe_to_close_on_neutral
peak ROE >= min_peak_roe_to_close_on_neutral
peak - current >= min_giveback_to_close_on_neutral
neutral votes >= neutral_close_votes
consecutive neutral close observations >= require_consecutive_neutral_close
```

Example:

```text
ADAUSDT LONG
current ROE +8.87%
peak ROE +14.05%
current signal HOLD
votes L=0 S=0 N=3
```

With `close_on_neutral_decay=false`, this remains a protection event. With `close_on_neutral_decay=true` and the close thresholds met, Exit Eye closes the position with `AEGIS_EXIT_EYE_NEUTRAL_DECAY`.

Opposite signal:

```text
current ROE >= min_roe_to_close_on_opposite
peak ROE >= min_peak_roe_to_close_on_opposite
Turbo raw/gated/current action is opposite the position side
opposite votes >= opposite_votes_to_close
consecutive opposite observations >= require_consecutive_opposite
```

Safety rules:

```text
current ROE <= 0 never closes
peak ROE below threshold never closes
minutes in trade below min_minutes_in_trade never closes
loss exits remain owned by SL/trailing/risk manager
```

## Config

Live config defaults to SHADOW:

```yaml
aegis:
  exit_eye:
    enabled: true
    mode: SHADOW
    min_roe_to_protect: 0.08
    min_peak_roe_to_protect: 0.12
    min_giveback_from_peak_roe: 0.04
    neutral_votes_to_protect: 2
    opposite_votes_to_close: 2
    min_roe_to_close_on_opposite: 0.06
    min_peak_roe_to_close_on_opposite: 0.10
    close_on_neutral_decay: false
    neutral_close_votes: 3
    min_roe_to_close_on_neutral: 0.08
    min_peak_roe_to_close_on_neutral: 0.12
    min_giveback_to_close_on_neutral: 0.04
    require_consecutive_neutral_close: 2
    require_consecutive_neutral: 2
    require_consecutive_opposite: 1
    min_minutes_in_trade: 3
```

If the config is missing or the YAML fails to load, defaults are safe:

```text
enabled=false
mode=OFF
close_on_neutral_decay=false
```

## Logs

History events are written through `AegisTurboHistoryLogger.logTradeEvent`:

```text
AEGIS_EXIT_EYE_SHADOW_PROTECT
AEGIS_EXIT_EYE_SHADOW_CLOSE
AEGIS_EXIT_EYE_PROTECT_PROFIT
AEGIS_EXIT_EYE_CLOSE_POSITION
```

Metadata includes:

```text
decision
currentRoe
peakRoe
givebackRoe
currentTurboAction
rawAction
gatedAction
turboScore
votes
reason
```

The analyzer reports:

```text
exit_eye_shadow_protect_count
exit_eye_shadow_close_count
exit_eye_close_count
avg_roe_when_exit_eye_triggered
avg_giveback_when_exit_eye_triggered
```

## Activation Path

1. Run in `SHADOW` for enough live trades.
2. Review event counts, ROE at trigger, giveback, and eventual trade outcome.
3. Test `PROTECT` only after a dedicated safe stop-move helper exists.
4. Enable `CLOSE` only after evidence shows opposite-signal exits improve net results.
5. Enable `close_on_neutral_decay` only when strong neutral votes plus profit giveback should exit instead of only protecting.

Do not close just because HOLD appears. Neutral closes require profit, minimum peak, sufficient giveback, strong neutral votes, consecutive confirmation, `mode=CLOSE`, and `close_on_neutral_decay=true`.
