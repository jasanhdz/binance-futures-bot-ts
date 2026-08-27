# AEGIS Telegram Notifications

## Block Alerts

Aegis entry-block Telegram alerts are disabled by default in live config. Blocked
entries remain available through JSONL logs and the `/blocks` on-demand Telegram
commands.

When `automatic_block_alerts_enabled: true`, Aegis live block notifications use an
in-memory dedupe/rate-limit layer before Telegram. This only affects Telegram delivery
for repeated entry-block messages. Trading decisions, history events, and normal logs
remain complete.

The dedupe key is:

```text
symbol|side|reason|eventRiskMode|decisionBrain|entryQuality|setupGrade
```

The key intentionally excludes timestamp, mark price, exact account values, and other
high-churn fields so repeated blocks of the same cause collapse into one Telegram stream.

## What Is Suppressed

Repeated Aegis entry block notifications from Decision Enforcement are suppressed when
the same symbol, side, reason, EventRisk mode, DecisionBrain decision, EntryQuality
recommendation, and setup grade repeat inside the cooldown window.

Examples:

- `decision_brain_wait_confirmation`
- `decision_brain_do_not_enter`
- `decision_brain_manual_only`
- `entry_quality_shadow_block_hard_denied`
- `event_risk_caution_denied_weak_setup`
- `event_risk_risk_off_denied_non_a_plus`

The underlying `DECISION_ENFORCEMENT_DENIED` trade event is still written every time.

## What Is Not Suppressed

Critical safety and execution alerts do not use this block dedupe path:

- emergency close failures
- bracket placement failures
- position-without-bracket alerts
- API/connectivity failures
- capital preservation locks
- liquidation-risk alerts
- entry/order/bracket execution notifications
- ExitEye and ProfitGuardian execution alerts

Those alerts remain independent from repeated weak-entry block suppression.

## Send Rules

Telegram sends when:

- `automatic_block_alerts_enabled: true`
- a block key is seen for the first time
- the same symbol/side changes reason, EventRisk mode, DecisionBrain, EntryQuality, or setup grade
- the same block repeats after the cooldown
- repeated suppressed blocks reach the summary threshold

Telegram suppresses when:

- the same key repeats before cooldown and before the summary threshold

Suppressed notifications are logged as `telegram_block_notification_suppressed`.
Summary notifications are logged as `telegram_block_notification_summary_sent`.

## Config

Live config:

```yaml
aegis:
  telegram_notifications:
    automatic_block_alerts_enabled: false
    block_dedupe:
      enabled: true
      cooldown_minutes: 15
      summary_threshold: 25
      max_cache_entries: 1000
      include_suppressed_count: true
```

`automatic_block_alerts_enabled: false` means Decision Enforcement block alerts are not
sent automatically. Use `/blocks`, `/blocks detail SYMBOL`, and `/blocks near-miss`
instead.

If automatic block alerts are explicitly re-enabled, the cache is memory-only and resets
on process restart. `max_cache_entries` prevents unbounded growth; oldest block keys are
evicted first. If `block_dedupe.enabled: false` while automatic alerts are enabled, the
dedupe layer is bypassed and every block notification is sent.

## Reading Telegram

`Repeticiones silenciadas: 18 en 15m` means the same block key repeated 18 times since
the previous Telegram notification for that key. Logs and JSONL history still contain
the individual blocked events.

## On-Demand Block Reports

Telegram also supports manual read-only reports:

```text
/blocks
/blocks SYMBOL
/blocks reasons
/blocks symbols
/blocks detail SYMBOL
/blocks near-miss
```

Examples:

```text
/blocks 4h
/blocks LINKUSDT 6h
/blocks reasons 24h
/blocks detail ADAUSDT
/blocks near-miss 2h
```

These commands read local `logs/aegis/turbo_trade_events_YYYY-MM-DD.jsonl` files and
summarize the selected time window. The Telegram report is intentionally compact; the
JSONL logs remain the complete source for audit, replay, and offline analysis.

`/blocks` also counts allowed/execution events in the same window:

- `GATE_ALLOWED`
- `ORDER_SUBMITTED`
- `POSITION_CONFIRMED`
- `BRACKETS_CONFIRMED`
- `TRADE_CLOSED`

This helps distinguish "everything is blocked" from "entries were filtered but some
operations still passed".

## Manual Validation

Do not restart PM2 automatically from Codex. Manual restart commands:

```bash
pm2 restart 01-Trading-Bot --update-env
pm2 save
```

After restart, inspect suppression/summary history:

```bash
grep -R "telegram_block_notification_suppressed\\|telegram_block_notification_summary_sent" logs/aegis/turbo_trade_events_$(date +%F).jsonl | tail -50
```

Expected behavior:

- first block arrives in Telegram
- repeated same-key blocks do not spam Telegram
- changed block reason/state sends a fresh Telegram
- summary arrives after threshold or cooldown
