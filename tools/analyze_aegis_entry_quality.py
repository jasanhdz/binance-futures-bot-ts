#!/usr/bin/env python3
"""Offline Aegis Turbo entry-quality analyzer.

Reads local Aegis Turbo JSONL logs and writes JSON/Markdown reports under
./reports. It never calls Binance, live APIs, PM2, or model code.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Iterable


DEFAULT_REQUIRED_DATES = {"2026-05-08", "2026-05-09", "2026-05-10"}
SNAPSHOT_WINDOWS_MINUTES = (5, 10, 15, 30)
ROE_TARGETS = (0.05, 0.08, 0.10)
SCORE_BUCKETS = [
    ("0.60-0.65", 0.60, 0.65),
    ("0.65-0.70", 0.65, 0.70),
    ("0.70-0.80", 0.70, 0.80),
    ("0.80-0.90", 0.80, 0.90),
    (">=0.90", 0.90, float("inf")),
]
QUALITY_LABELS = [
    "EXCELLENT",
    "GOOD",
    "SLOW_WIN",
    "BAD_ENTRY_WIN",
    "BAD_ENTRY_LOSS",
    "UNKNOWN",
]


@dataclass
class JsonlRead:
    rows: list[dict[str, Any]]
    files_read: int = 0
    missing_files: int = 0
    corrupt_lines: int = 0


@dataclass
class SnapshotPoint:
    ts: datetime
    roe: float | None
    pnl: float | None
    mark_price: float | None
    entry_price: float | None
    side: str | None


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    text = str(value)
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def iso(dt: datetime | None) -> str:
    if dt is None:
        return "n/a"
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def utc_now_tag() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def safe_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        out = float(value)
        if math.isnan(out) or math.isinf(out):
            return None
        return out
    except (TypeError, ValueError):
        return None


def safe_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def mean(values: Iterable[float | None]) -> float | None:
    nums = [v for v in values if v is not None]
    if not nums:
        return None
    return sum(nums) / len(nums)


def med(values: Iterable[float | None]) -> float | None:
    nums = [v for v in values if v is not None]
    if not nums:
        return None
    return float(median(nums))


def rounded(value: Any, digits: int = 6) -> float | str:
    num = safe_float(value)
    if num is None:
        return "n/a"
    return round(num, digits)


def rounded_or_none(value: Any, digits: int = 6) -> float | None:
    num = safe_float(value)
    if num is None:
        return None
    return round(num, digits)


def fmt(value: Any, digits: int = 4) -> str:
    num = safe_float(value)
    if num is None:
        return "n/a"
    return f"{num:.{digits}f}"


def fmt_pct(value: Any) -> str:
    num = safe_float(value)
    if num is None:
        return "n/a"
    return f"{num * 100:.2f}%"


def fmt_minutes(value: Any) -> str:
    num = safe_float(value)
    if num is None:
        return "n/a"
    return f"{num:.1f}m"


def n_a(value: Any) -> Any:
    if value is None:
        return "n/a"
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return "n/a"
    return value


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_safe(v) for v in value]
    if isinstance(value, tuple):
        return [json_safe(v) for v in value]
    if isinstance(value, datetime):
        return iso(value)
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return "n/a"
    return value


def read_jsonl_files(paths: Iterable[Path]) -> JsonlRead:
    result = JsonlRead(rows=[])
    for path in paths:
        if not path.exists():
            result.missing_files += 1
            continue
        result.files_read += 1
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for raw_line in handle:
                line = raw_line.replace("\x00", "").strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                    if isinstance(parsed, dict):
                        parsed["_source_file"] = str(path)
                        result.rows.append(parsed)
                    else:
                        result.corrupt_lines += 1
                except json.JSONDecodeError:
                    result.corrupt_lines += 1
    return result


def extract_date(path: Path) -> str | None:
    match = re.search(r"(\d{4}-\d{2}-\d{2})", path.name)
    return match.group(1) if match else None


def available_dates(log_dir: Path) -> list[str]:
    dates: set[str] = set()
    if not log_dir.exists():
        return []
    for path in log_dir.glob("*.jsonl"):
        date = extract_date(path)
        if date:
            dates.add(date)
    return sorted(dates)


def select_dates(log_dir: Path, requested: list[str] | None, include_all_recent: bool) -> list[str]:
    if requested:
        return sorted(set(requested))
    dates = available_dates(log_dir)
    if include_all_recent:
        return dates
    selected = {date for date in dates if date in DEFAULT_REQUIRED_DATES or date > "2026-05-10"}
    if selected:
        return sorted(selected)
    return dates[-3:]


def file_paths(log_dir: Path, prefix: str, dates: list[str]) -> list[Path]:
    return [log_dir / f"{prefix}_{date}.jsonl" for date in dates]


def votes_key(votes: dict[str, Any] | None) -> dict[str, int | str]:
    votes = votes or {}
    return {
        "long": safe_int(votes.get("long")) if safe_int(votes.get("long")) is not None else "n/a",
        "short": safe_int(votes.get("short")) if safe_int(votes.get("short")) is not None else "n/a",
        "neutral": safe_int(votes.get("neutral")) if safe_int(votes.get("neutral")) is not None else "n/a",
    }


def directional_votes(side: str | None, votes: dict[str, Any] | None) -> int | None:
    if not side or not votes:
        return None
    side = side.upper()
    if side == "LONG":
        return safe_int(votes.get("long"))
    if side == "SHORT":
        return safe_int(votes.get("short"))
    return None


def entry_reason(row: dict[str, Any] | None) -> str:
    if not row:
        return "n/a"
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    for key in ("rawReason", "gatedReason", "reason", "safe_reason"):
        value = metadata.get(key)
        if value:
            return str(value)
    for key in ("reason", "gate_reason"):
        value = row.get(key)
        if value:
            return str(value)
    return "n/a"


def price_close(a: Any, b: Any) -> bool:
    fa = safe_float(a)
    fb = safe_float(b)
    if fa is None or fb is None:
        return True
    if fa == fb:
        return True
    denom = max(abs(fa), abs(fb), 1e-12)
    return abs(fa - fb) / denom <= 0.002


def build_snapshot_index(rows: list[dict[str, Any]]) -> dict[str, list[SnapshotPoint]]:
    by_symbol: dict[str, list[SnapshotPoint]] = defaultdict(list)
    for row in rows:
        ts = parse_dt(row.get("timestamp"))
        if ts is None:
            continue
        symbols = row.get("symbols")
        if not isinstance(symbols, list):
            continue
        for item in symbols:
            if not isinstance(item, dict):
                continue
            symbol = item.get("symbol")
            if not symbol:
                continue
            if item.get("position_open") is False:
                continue
            by_symbol[str(symbol)].append(
                SnapshotPoint(
                    ts=ts,
                    roe=safe_float(item.get("roe")),
                    pnl=safe_float(item.get("unrealized_pnl")),
                    mark_price=safe_float(item.get("mark_price")),
                    entry_price=safe_float(item.get("entry_price")),
                    side=str(item.get("side")).upper() if item.get("side") else None,
                )
            )
    for points in by_symbol.values():
        points.sort(key=lambda p: p.ts)
    return by_symbol


def snapshots_for_trade(
    snapshot_index: dict[str, list[SnapshotPoint]],
    symbol: str,
    side: str | None,
    entry_price: float | None,
    opened_at: datetime | None,
    closed_at: datetime | None,
) -> list[SnapshotPoint]:
    if opened_at is None:
        return []
    out: list[SnapshotPoint] = []
    for point in snapshot_index.get(symbol, []):
        if point.ts < opened_at:
            continue
        if closed_at is not None and point.ts > closed_at:
            continue
        if side and point.side and point.side.upper() != side.upper():
            continue
        if entry_price is not None and point.entry_price is not None and not price_close(point.entry_price, entry_price):
            continue
        out.append(point)
    return out


def minutes_between(start: datetime | None, end: datetime | None) -> float | None:
    if start is None or end is None:
        return None
    return (end - start).total_seconds() / 60


def min_roe_in_window(points: list[SnapshotPoint], opened_at: datetime | None, minutes: int) -> float | None:
    if opened_at is None:
        return None
    values = [
        point.roe
        for point in points
        if point.roe is not None and 0 <= minutes_between(opened_at, point.ts) <= minutes
    ]
    return min(values) if values else None


def first_time_to(points: list[SnapshotPoint], opened_at: datetime | None, threshold: float, inclusive: bool) -> float | None:
    if opened_at is None:
        return None
    for point in points:
        if point.roe is None:
            continue
        if inclusive:
            passed = point.roe >= threshold
        else:
            passed = point.roe > threshold
        if passed:
            return minutes_between(opened_at, point.ts)
    return None


def quality_label(final_roe: float | None, mae_roe: float | None, time_to_green: float | None) -> str:
    if final_roe is None or mae_roe is None:
        return "UNKNOWN"
    if final_roe > 0 and mae_roe <= -0.15:
        return "BAD_ENTRY_WIN"
    if final_roe <= 0 and mae_roe <= -0.15:
        return "BAD_ENTRY_LOSS"
    if final_roe > 0 and time_to_green is not None and time_to_green > 30:
        return "SLOW_WIN"
    if final_roe > 0 and mae_roe >= -0.05 and time_to_green is not None and time_to_green <= 10:
        return "EXCELLENT"
    if final_roe > 0 and mae_roe >= -0.10:
        return "GOOD"
    return "UNKNOWN"


def latest_by_trade(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        trade_id = row.get("trade_id")
        if not trade_id:
            continue
        ts = parse_dt(row.get("timestamp")) or parse_dt(row.get("closed_at")) or parse_dt(row.get("opened_at"))
        prev = out.get(str(trade_id))
        prev_ts = parse_dt(prev.get("timestamp")) if prev else None
        if prev is None or (ts is not None and (prev_ts is None or ts >= prev_ts)):
            out[str(trade_id)] = row
    return out


def merge_trade_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    open_rows: dict[str, dict[str, Any]] = {}
    close_rows: dict[str, dict[str, Any]] = {}
    all_latest = latest_by_trade(rows)
    duplicate_counts = Counter(str(row.get("trade_id")) for row in rows if row.get("trade_id"))

    for row in rows:
        trade_id = row.get("trade_id")
        if not trade_id:
            continue
        trade_id = str(trade_id)
        status = str(row.get("status") or "").upper()
        if status == "OPEN" and trade_id not in open_rows:
            open_rows[trade_id] = row
        if status == "CLOSED" and is_verified_bot_metric_row(row):
            prev = close_rows.get(trade_id)
            row_closed = parse_dt(row.get("closed_at")) or parse_dt(row.get("timestamp"))
            prev_closed = parse_dt(prev.get("closed_at")) or parse_dt(prev.get("timestamp")) if prev else None
            if prev is None or (row_closed is not None and (prev_closed is None or row_closed >= prev_closed)):
                close_rows[trade_id] = row

    trades: list[dict[str, Any]] = []
    for trade_id in sorted(all_latest):
        base = dict(open_rows.get(trade_id) or {})
        latest = all_latest[trade_id]
        closed = close_rows.get(trade_id)
        merged = dict(base)
        merged.update(latest)
        if closed:
            merged.update(closed)
            merged["_close_row"] = closed
        if base:
            merged["_open_row"] = base
        merged["_trade_id"] = trade_id
        merged["_record_count"] = duplicate_counts[trade_id]
        trades.append(merged)

    diagnostics = {
        "unique_trade_ids": len(trades),
        "open_record_ids": len(open_rows),
        "closed_record_ids": len(close_rows),
        "trade_ids_with_multiple_records": sum(1 for count in duplicate_counts.values() if count > 1),
    }
    return trades, diagnostics


def is_verified_bot_metric_row(row: dict[str, Any]) -> bool:
    return (
        row.get("owner") == "AEGIS"
        and row.get("origin") == "BOT"
        and row.get("ownership_status") == "VERIFIED"
        and row.get("eligible_for_bot_metrics") is True
    )


def build_trade_metrics(
    trade_rows: list[dict[str, Any]],
    snapshot_index: dict[str, list[SnapshotPoint]],
) -> tuple[list[dict[str, Any]], list[str]]:
    metrics: list[dict[str, Any]] = []
    warnings: list[str] = []
    for row in trade_rows:
        trade_id = str(row.get("_trade_id") or row.get("trade_id") or "n/a")
        symbol = str(row.get("symbol") or "n/a")
        side = str(row.get("side") or "n/a").upper()
        opened_at = parse_dt(row.get("opened_at"))
        closed_at = parse_dt(row.get("closed_at"))
        status = str(row.get("status") or ("CLOSED" if closed_at else "OPEN")).upper()
        entry = safe_float(row.get("entry_price"))
        leverage = safe_float(row.get("leverage"))
        open_row = row.get("_open_row") if isinstance(row.get("_open_row"), dict) else None
        close_row = row.get("_close_row") if isinstance(row.get("_close_row"), dict) else None
        score = safe_float((open_row or row).get("turbo_score"))
        votes = (open_row or row).get("votes") if isinstance((open_row or row).get("votes"), dict) else None
        trailing_activation = safe_float((open_row or row).get("trailing_activation_roe"))
        if trailing_activation is None:
            trailing_activation = 0.15

        points = snapshots_for_trade(snapshot_index, symbol, side, entry, opened_at, closed_at)
        duration = safe_float(row.get("duration_minutes"))
        if duration is None:
            end = closed_at or (points[-1].ts if points else parse_dt(row.get("timestamp")))
            duration = minutes_between(opened_at, end)

        snapshot_roes = [p.roe for p in points if p.roe is not None]
        row_mae = safe_float(row.get("mae_roe"))
        row_mfe = safe_float(row.get("mfe_roe"))
        mae = row_mae if row_mae is not None else (min(snapshot_roes) if snapshot_roes else None)
        mfe = row_mfe if row_mfe is not None else (max(snapshot_roes) if snapshot_roes else None)
        final_roe = safe_float(row.get("roe"))
        pnl = safe_float(row.get("pnl_usdt"))
        if status != "CLOSED" and points:
            final_roe = points[-1].roe if points[-1].roe is not None else final_roe
            pnl = points[-1].pnl if points[-1].pnl is not None else pnl
        if final_roe is None and status == "CLOSED":
            final_roe = row_mae if row_mae and row_mae > 0 else None

        early = {f"early_mae_{minutes}m": min_roe_in_window(points, opened_at, minutes) for minutes in SNAPSHOT_WINDOWS_MINUTES}
        time_to_green = first_time_to(points, opened_at, 0.0, inclusive=False)
        time_to_be = first_time_to(points, opened_at, 0.0, inclusive=True)
        time_to_targets = {
            "time_to_5pct_roe_minutes": first_time_to(points, opened_at, 0.05, inclusive=True),
            "time_to_8pct_roe_minutes": first_time_to(points, opened_at, 0.08, inclusive=True),
            "time_to_10pct_roe_minutes": first_time_to(points, opened_at, 0.10, inclusive=True),
        }
        time_to_trailing = first_time_to(points, opened_at, trailing_activation, inclusive=True)
        efficiency = None
        if mae is not None and mfe is not None and mae < 0:
            efficiency = mfe / abs(mae)

        label = quality_label(final_roe, mae, time_to_green)
        if not points:
            warnings.append(f"{trade_id}: no intratrade account snapshots matched for early/time metrics")

        metric = {
            "trade_id": trade_id,
            "symbol": symbol,
            "side": side,
            "status": status,
            "entry_time": iso(opened_at),
            "exit_time": iso(closed_at),
            "duration_minutes": rounded(duration),
            "entry_score": rounded(score),
            "votes": votes_key(votes),
            "directional_votes": n_a(directional_votes(side, votes)),
            "entry_reason": entry_reason(open_row or row),
            "exit_reason": row.get("exit_reason") or row.get("reason") or "n/a",
            "final_roe": rounded(final_roe),
            "pnl_usdt": rounded(pnl),
            "mfe_roe": rounded(mfe),
            "mae_roe": rounded(mae),
            "early_mae_5m": rounded(early["early_mae_5m"]),
            "early_mae_10m": rounded(early["early_mae_10m"]),
            "early_mae_15m": rounded(early["early_mae_15m"]),
            "early_mae_30m": rounded(early["early_mae_30m"]),
            "time_to_green_minutes": rounded(time_to_green),
            "time_to_5pct_roe_minutes": rounded(time_to_targets["time_to_5pct_roe_minutes"]),
            "time_to_8pct_roe_minutes": rounded(time_to_targets["time_to_8pct_roe_minutes"]),
            "time_to_10pct_roe_minutes": rounded(time_to_targets["time_to_10pct_roe_minutes"]),
            "time_to_be_minutes": rounded(time_to_be),
            "time_to_trailing_activation_minutes": rounded(time_to_trailing),
            "entry_efficiency": rounded(efficiency),
            "quality_label": label,
            "snapshot_points": len(points),
            "_numeric": {
                "duration_minutes": duration,
                "entry_score": score,
                "final_roe": final_roe,
                "pnl_usdt": pnl,
                "mfe_roe": mfe,
                "mae_roe": mae,
                "early_mae_10m": early["early_mae_10m"],
                "time_to_green_minutes": time_to_green,
                "time_to_8pct_roe_minutes": time_to_targets["time_to_8pct_roe_minutes"],
                "entry_efficiency": efficiency,
                "directional_votes": directional_votes(side, votes),
            },
        }
        metrics.append(metric)
    return metrics, warnings


def is_bad_entry(metric: dict[str, Any]) -> bool:
    return metric.get("quality_label") in {"BAD_ENTRY_WIN", "BAD_ENTRY_LOSS"}


def numeric(metric: dict[str, Any], key: str) -> float | None:
    raw = metric.get("_numeric")
    if isinstance(raw, dict):
        return safe_float(raw.get(key))
    return safe_float(metric.get(key))


def win(metric: dict[str, Any]) -> bool | None:
    final = numeric(metric, "final_roe")
    if final is None:
        return None
    return final > 0


def aggregate_metrics(items: list[dict[str, Any]]) -> dict[str, Any]:
    labels = Counter(str(item.get("quality_label") or "UNKNOWN") for item in items)
    wins = [win(item) for item in items if win(item) is not None]
    pnl_values = [numeric(item, "pnl_usdt") for item in items if numeric(item, "pnl_usdt") is not None]
    known_quality = [item for item in items if item.get("quality_label") != "UNKNOWN"]
    return {
        "trades": len(items),
        "closed_trades": sum(1 for item in items if item.get("status") == "CLOSED"),
        "open_trades": sum(1 for item in items if item.get("status") == "OPEN"),
        "excellent_count": labels["EXCELLENT"],
        "good_count": labels["GOOD"],
        "slow_win_count": labels["SLOW_WIN"],
        "bad_entry_win_count": labels["BAD_ENTRY_WIN"],
        "bad_entry_loss_count": labels["BAD_ENTRY_LOSS"],
        "unknown_count": labels["UNKNOWN"],
        "avg_mae": rounded_or_none(mean(numeric(item, "mae_roe") for item in items)),
        "median_mae": rounded_or_none(med(numeric(item, "mae_roe") for item in items)),
        "avg_early_mae_10m": rounded_or_none(mean(numeric(item, "early_mae_10m") for item in items)),
        "avg_time_to_green": rounded_or_none(mean(numeric(item, "time_to_green_minutes") for item in items)),
        "avg_time_to_8pct_roe": rounded_or_none(mean(numeric(item, "time_to_8pct_roe_minutes") for item in items)),
        "avg_entry_efficiency": rounded_or_none(mean(numeric(item, "entry_efficiency") for item in items)),
        "net_pnl": rounded_or_none(sum(pnl_values) if pnl_values else None),
        "win_rate": rounded_or_none((sum(1 for value in wins if value) / len(wins)) if wins else None),
        "bad_entry_rate": rounded_or_none((sum(1 for item in known_quality if is_bad_entry(item)) / len(known_quality)) if known_quality else None),
    }


def recommend_symbol(stats: dict[str, Any]) -> str:
    trades = int(stats.get("trades") or 0)
    if trades < 3:
        return "NEED_MORE_DATA"
    bad_rate = safe_float(stats.get("bad_entry_rate")) or 0.0
    win_rate = safe_float(stats.get("win_rate"))
    avg_mae = safe_float(stats.get("avg_mae"))
    avg_ttg = safe_float(stats.get("avg_time_to_green"))
    net_pnl = safe_float(stats.get("net_pnl"))
    if net_pnl is not None and net_pnl < 0 and (bad_rate >= 0.30 or (win_rate is not None and win_rate < 0.45)):
        return "SHADOW_ONLY"
    if avg_mae is not None and avg_mae <= -0.20:
        return "REDUCE_SIZE"
    if bad_rate >= 0.25 or (avg_ttg is not None and avg_ttg > 30):
        return "REQUIRE_MOMENTUM_CONFIRM"
    if win_rate is not None and win_rate < 0.50:
        return "RAISE_THRESHOLD"
    if net_pnl is not None and net_pnl < 0:
        return "REDUCE_SIZE"
    return "KEEP"


def aggregate_by_symbol(metrics: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for metric in metrics:
        groups[str(metric.get("symbol") or "n/a")].append(metric)
    out: dict[str, dict[str, Any]] = {}
    for symbol, items in sorted(groups.items()):
        stats = aggregate_metrics(items)
        stats["recommendation"] = recommend_symbol(stats)
        out[symbol] = stats
    return out


def aggregate_by_side(metrics: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for metric in metrics:
        groups[str(metric.get("side") or "n/a")].append(metric)
    return {side: aggregate_metrics(items) for side, items in sorted(groups.items())}


def score_bucket(score: float | None) -> str | None:
    if score is None:
        return None
    for label, low, high in SCORE_BUCKETS:
        if score >= low and score < high:
            return label
    return None


def aggregate_score_buckets(metrics: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {label: [] for label, _, _ in SCORE_BUCKETS}
    missing = []
    below = []
    for metric in metrics:
        score = numeric(metric, "entry_score")
        label = score_bucket(score)
        if label:
            groups[label].append(metric)
        elif score is None:
            missing.append(metric)
        else:
            below.append(metric)
    out = {label: aggregate_metrics(groups[label]) for label, _, _ in SCORE_BUCKETS}
    if missing:
        out["n/a"] = aggregate_metrics(missing)
    if below:
        out["<0.60"] = aggregate_metrics(below)
    return out


def aggregate_votes(metrics: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {
        "LONG 2/3": [],
        "LONG 3/3": [],
        "SHORT 2/3": [],
        "SHORT 3/3": [],
        "OTHER": [],
    }
    for metric in metrics:
        side = str(metric.get("side") or "").upper()
        votes = numeric(metric, "directional_votes")
        if side in {"LONG", "SHORT"} and votes in {2, 3}:
            groups[f"{side} {int(votes)}/3"].append(metric)
        else:
            groups["OTHER"].append(metric)
    return {label: aggregate_metrics(items) for label, items in groups.items() if items or label != "OTHER"}


def answer_questions(
    side_stats: dict[str, dict[str, Any]],
    score_stats: dict[str, dict[str, Any]],
    vote_stats: dict[str, dict[str, Any]],
    metrics: list[dict[str, Any]],
) -> dict[str, Any]:
    long_stats = side_stats.get("LONG", {})
    short_stats = side_stats.get("SHORT", {})
    long_mae = safe_float(long_stats.get("avg_mae"))
    short_mae = safe_float(short_stats.get("avg_mae"))
    long_bad = safe_float(long_stats.get("bad_entry_rate"))
    short_bad = safe_float(short_stats.get("bad_entry_rate"))
    long_eff = safe_float(long_stats.get("avg_entry_efficiency"))
    short_eff = safe_float(short_stats.get("avg_entry_efficiency"))

    long_cleaner = "n/a"
    if long_mae is not None and short_mae is not None and long_bad is not None and short_bad is not None:
        long_cleaner = "yes" if long_mae >= short_mae and long_bad <= short_bad else "no"

    short_filter = "n/a"
    if short_bad is not None or short_mae is not None:
        short_filter = "yes" if (short_bad is not None and short_bad >= 0.20) or (short_mae is not None and short_mae <= -0.12) else "not clearly"

    bad_entries = [m for m in metrics if is_bad_entry(m)]
    bad_low_signal = [
        m
        for m in bad_entries
        if (numeric(m, "directional_votes") is not None and numeric(m, "directional_votes") <= 2)
        or (numeric(m, "entry_score") is not None and numeric(m, "entry_score") < 0.70)
    ]
    high_score_bad = [m for m in bad_entries if (numeric(m, "entry_score") or 0) >= 0.80]

    populated_buckets = {k: v for k, v in score_stats.items() if int(v.get("trades") or 0) > 0 and k not in {"n/a", "<0.60"}}
    cleanest_bucket = None
    worst_bucket = None
    if populated_buckets:
        cleanest_bucket = min(
            populated_buckets,
            key=lambda k: (
                safe_float(populated_buckets[k].get("bad_entry_rate")) if safe_float(populated_buckets[k].get("bad_entry_rate")) is not None else 9,
                safe_float(populated_buckets[k].get("avg_mae")) if safe_float(populated_buckets[k].get("avg_mae")) is not None else -9,
            ),
        )
        worst_bucket = max(
            populated_buckets,
            key=lambda k: (
                safe_float(populated_buckets[k].get("bad_entry_rate")) if safe_float(populated_buckets[k].get("bad_entry_rate")) is not None else -1,
                -(safe_float(populated_buckets[k].get("avg_mae")) if safe_float(populated_buckets[k].get("avg_mae")) is not None else 9),
            ),
        )

    def better_votes(side: str) -> str:
        s2 = vote_stats.get(f"{side} 2/3", {})
        s3 = vote_stats.get(f"{side} 3/3", {})
        if not s2 or not s3 or int(s2.get("trades") or 0) == 0 or int(s3.get("trades") or 0) == 0:
            return "n/a"
        s2_bad = safe_float(s2.get("bad_entry_rate")) or 0
        s3_bad = safe_float(s3.get("bad_entry_rate")) or 0
        s2_mae = safe_float(s2.get("avg_mae"))
        s3_mae = safe_float(s3.get("avg_mae"))
        return "yes" if s3_bad <= s2_bad and (s2_mae is None or s3_mae is None or s3_mae >= s2_mae) else "no"

    return {
        "long_enters_cleaner_than_short": long_cleaner,
        "short_needs_extra_filter": short_filter,
        "bad_trades_low_signal": {
            "bad_entries": len(bad_entries),
            "bad_entries_with_2of3_or_score_below_0_70": len(bad_low_signal),
            "answer": "yes" if bad_entries and len(bad_low_signal) / len(bad_entries) >= 0.50 else "no" if bad_entries else "n/a",
        },
        "high_score_bad_entries": {
            "bad_entries_score_gte_0_80": len(high_score_bad),
            "answer": "yes" if high_score_bad else "no",
        },
        "score_high_enters_cleaner": {
            "cleanest_bucket": cleanest_bucket or "n/a",
            "worst_bucket": worst_bucket or "n/a",
            "answer": "yes" if cleanest_bucket in {"0.80-0.90", ">=0.90"} else "not clearly",
        },
        "bucket_to_block": worst_bucket or "n/a",
        "is_0_60_too_low_for_some_symbols": "yes" if any((numeric(m, "entry_score") or 1) < 0.65 and is_bad_entry(m) for m in metrics) else "not proven",
        "votes_3of3_improves_entry_quality": {
            "LONG": better_votes("LONG"),
            "SHORT": better_votes("SHORT"),
        },
        "votes_2of3_enters_too_early": "yes" if any(
            (numeric(m, "directional_votes") == 2 and is_bad_entry(m)) for m in metrics
        ) else "not proven",
        "short_3of3_really_better": better_votes("SHORT"),
        "side_comparison_raw": {
            "LONG": {
                "avg_mae": long_stats.get("avg_mae", "n/a"),
                "bad_entry_rate": long_stats.get("bad_entry_rate", "n/a"),
                "entry_efficiency": long_eff if long_eff is not None else "n/a",
            },
            "SHORT": {
                "avg_mae": short_stats.get("avg_mae", "n/a"),
                "bad_entry_rate": short_stats.get("bad_entry_rate", "n/a"),
                "entry_efficiency": short_eff if short_eff is not None else "n/a",
            },
        },
    }


def filter_recommendations(symbol_stats: dict[str, dict[str, Any]], side_stats: dict[str, dict[str, Any]]) -> dict[str, Any]:
    short_bad = safe_float(side_stats.get("SHORT", {}).get("bad_entry_rate"))
    long_bad = safe_float(side_stats.get("LONG", {}).get("bad_entry_rate"))
    short_needs = short_bad is not None and short_bad >= 0.20
    long_needs = long_bad is not None and long_bad >= 0.25

    per_symbol: dict[str, Any] = {}
    for symbol, stats in symbol_stats.items():
        rec = stats.get("recommendation")
        bad_rate = safe_float(stats.get("bad_entry_rate")) or 0
        avg_mae = safe_float(stats.get("avg_mae"))
        trades = int(stats.get("trades") or 0)
        min_score = 0.60
        require_3of3 = False
        require_momentum = False
        reduce_size = False
        shadow_only = False
        if trades < 3:
            min_score = 0.65
        if bad_rate >= 0.20:
            min_score = 0.70
            require_momentum = True
        if bad_rate >= 0.35 or (avg_mae is not None and avg_mae <= -0.18):
            min_score = 0.80
            require_3of3 = True
            reduce_size = True
        if rec == "SHADOW_ONLY":
            shadow_only = True
        per_symbol[symbol] = {
            "suggested_min_score": round(min_score, 2),
            "require_momentum_confirm": require_momentum,
            "require_3of3": require_3of3,
            "reduce_leverage_or_size": reduce_size,
            "shadow_only": shadow_only,
            "reason": rec,
        }

    return {
        "global_filters": [
            {
                "name": "Momentum confirmation",
                "proposal": "LONG require micro_momentum >= 0; SHORT require micro_momentum <= 0",
                "priority": "HIGH" if short_needs or long_needs else "MEDIUM",
            },
            {
                "name": "Anti-falling-knife",
                "proposal": "Block LONG after 2-3 strongly negative recent candles; block SHORT after 2-3 strongly positive recent candles",
                "priority": "HIGH" if short_needs else "MEDIUM",
            },
            {
                "name": "Overextension filter",
                "proposal": "Block LONG too far above short EMA; block SHORT too far below short EMA",
                "priority": "MEDIUM",
            },
            {
                "name": "Volatility filter",
                "proposal": "Reduce size or block if recent ATR/realized volatility is above the symbol's recent percentile band",
                "priority": "MEDIUM",
            },
            {
                "name": "Score/votes tightening",
                "proposal": "Use higher min_score and/or 3/3 only for symbols with high bad-entry rate",
                "priority": "HIGH",
            },
        ],
        "per_symbol": per_symbol,
    }


def entry_quality_gate_v01(symbol_recs: dict[str, Any]) -> dict[str, Any]:
    min_score_by_symbol = {
        symbol: rec["suggested_min_score"]
        for symbol, rec in symbol_recs.get("per_symbol", {}).items()
        if rec.get("suggested_min_score") is not None
    }
    require_3of3_symbols = [
        symbol for symbol, rec in symbol_recs.get("per_symbol", {}).items() if rec.get("require_3of3")
    ]
    return {
        "name": "AegisEntryQualityGate v0.1",
        "enabled": True,
        "mode": "SHADOW",
        "defaults": {
            "min_score_by_side": {"LONG": 0.65, "SHORT": 0.70},
            "require_momentum_confirm": True,
            "momentum_confirm": {"LONG": "micro_momentum >= 0", "SHORT": "micro_momentum <= 0"},
            "max_early_volatility": "symbol_recent_atr_pct <= p75",
            "anti_falling_knife_lookback_candles": 3,
            "max_adverse_recent_return": 0.003,
            "overextension_ema_distance_limit": 0.006,
            "require_3of3_when_symbol_flagged": True,
            "reduce_size_when_symbol_flagged": 0.50,
        },
        "min_score_by_symbol": min_score_by_symbol,
        "require_3of3_symbols": require_3of3_symbols,
        "implementation_note": "Proposal only. Do not implement until shadow metrics confirm fewer bad entries without killing net PnL.",
    }


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        out.append("| " + " | ".join(str(cell) for cell in row) + " |")
    return "\n".join(out)


def top_symbols(symbol_stats: dict[str, dict[str, Any]], reverse: bool) -> list[tuple[str, dict[str, Any]]]:
    items = [(s, st) for s, st in symbol_stats.items() if int(st.get("trades") or 0) > 0]
    return sorted(
        items,
        key=lambda item: (
            safe_float(item[1].get("bad_entry_rate")) if safe_float(item[1].get("bad_entry_rate")) is not None else (9 if not reverse else -1),
            -(safe_float(item[1].get("avg_mae")) if safe_float(item[1].get("avg_mae")) is not None else -9),
            -(safe_float(item[1].get("net_pnl")) if safe_float(item[1].get("net_pnl")) is not None else -999),
        ),
        reverse=reverse,
    )


def render_markdown(report: dict[str, Any], summary_only: bool = False) -> str:
    period = report["period"]
    global_stats = report["global"]
    symbol_stats = report["by_symbol"]
    side_stats = report["long_vs_short"]
    score_stats = report["score_buckets"]
    vote_stats = report["votes_quality"]
    answers = report["answers"]
    filters = report["filter_recommendations"]
    gate = report["entry_quality_gate_v0_1"]
    warnings = report["warnings"]

    lines: list[str] = []
    title = "Aegis Turbo Entry Quality Summary For ChatGPT" if summary_only else "Aegis Turbo Entry Quality Analysis"
    lines.append(f"# {title}")
    lines.append("")
    lines.append(f"- Generated UTC: `{report['generated_at']}`")
    lines.append(f"- Period analyzed: `{period['start']}` to `{period['end']}`")
    lines.append(f"- Dates: `{', '.join(period['dates'])}`")
    lines.append(f"- Trades analyzed: `{global_stats['trades']}` (`{global_stats['closed_trades']}` closed, `{global_stats['open_trades']}` open)")
    lines.append(f"- Account snapshot points matched where available; missing intratrade paths are reported as `n/a`.")
    lines.append("")

    lines.append("## 1. Periodo analizado")
    lines.append(f"{period['start']} to {period['end']} UTC from local `logs/aegis/*.jsonl`.")
    lines.append("")

    lines.append("## 2. Trades analizados")
    lines.append(
        markdown_table(
            ["Trades", "Closed", "Open", "Net PnL", "Win Rate", "Avg MAE", "Bad Entry Rate"],
            [[
                global_stats["trades"],
                global_stats["closed_trades"],
                global_stats["open_trades"],
                fmt(global_stats.get("net_pnl"), 2),
                fmt_pct(global_stats.get("win_rate")),
                fmt_pct(global_stats.get("avg_mae")),
                fmt_pct(global_stats.get("bad_entry_rate")),
            ]],
        )
    )
    lines.append("")

    lines.append("## 3. Calidad global de entrada")
    lines.append(
        markdown_table(
            ["EXCELLENT", "GOOD", "SLOW_WIN", "BAD_ENTRY_WIN", "BAD_ENTRY_LOSS", "UNKNOWN"],
            [[
                global_stats["excellent_count"],
                global_stats["good_count"],
                global_stats["slow_win_count"],
                global_stats["bad_entry_win_count"],
                global_stats["bad_entry_loss_count"],
                global_stats["unknown_count"],
            ]],
        )
    )
    lines.append("")

    best = top_symbols(symbol_stats, reverse=False)[:5]
    worst = top_symbols(symbol_stats, reverse=True)[:5]
    lines.append("## 4. Mejores símbolos por entry quality")
    lines.append(
        markdown_table(
            ["Symbol", "Trades", "Avg MAE", "Bad Entry Rate", "Avg TTG", "Net PnL", "Recommendation"],
            [
                [
                    symbol,
                    stats["trades"],
                    fmt_pct(stats.get("avg_mae")),
                    fmt_pct(stats.get("bad_entry_rate")),
                    fmt_minutes(stats.get("avg_time_to_green")),
                    fmt(stats.get("net_pnl"), 2),
                    stats["recommendation"],
                ]
                for symbol, stats in best
            ],
        )
    )
    lines.append("")

    lines.append("## 5. Peores símbolos por entry quality")
    lines.append(
        markdown_table(
            ["Symbol", "Trades", "Avg MAE", "Bad Entry Rate", "Avg TTG", "Net PnL", "Recommendation"],
            [
                [
                    symbol,
                    stats["trades"],
                    fmt_pct(stats.get("avg_mae")),
                    fmt_pct(stats.get("bad_entry_rate")),
                    fmt_minutes(stats.get("avg_time_to_green")),
                    fmt(stats.get("net_pnl"), 2),
                    stats["recommendation"],
                ]
                for symbol, stats in worst
            ],
        )
    )
    lines.append("")

    lines.append("## 6. LONG vs SHORT")
    lines.append(
        markdown_table(
            ["Side", "Trades", "Avg MAE", "Avg TTG", "Bad Entry Rate", "Entry Efficiency", "Net PnL", "Win Rate"],
            [
                [
                    side,
                    stats["trades"],
                    fmt_pct(stats.get("avg_mae")),
                    fmt_minutes(stats.get("avg_time_to_green")),
                    fmt_pct(stats.get("bad_entry_rate")),
                    fmt(stats.get("avg_entry_efficiency"), 2),
                    fmt(stats.get("net_pnl"), 2),
                    fmt_pct(stats.get("win_rate")),
                ]
                for side, stats in side_stats.items()
            ],
        )
    )
    lines.append("")
    lines.append(f"- LONG entra más limpio que SHORT: `{answers['long_enters_cleaner_than_short']}`")
    lines.append(f"- SHORT necesita filtro adicional: `{answers['short_needs_extra_filter']}`")
    lines.append(f"- Trades malos con 2/3 o score < 0.70: `{answers['bad_trades_low_signal']['bad_entries_with_2of3_or_score_below_0_70']}/{answers['bad_trades_low_signal']['bad_entries']}`")
    lines.append(f"- Trades con score alto también tienen mala entrada: `{answers['high_score_bad_entries']['answer']}` (`{answers['high_score_bad_entries']['bad_entries_score_gte_0_80']}` casos)")
    lines.append("")

    lines.append("## 7. Score buckets")
    lines.append(
        markdown_table(
            ["Bucket", "Trades", "Avg MAE", "Median MAE", "Bad Entry Rate", "Avg TTG", "Net PnL", "Win Rate", "Efficiency"],
            [
                [
                    bucket,
                    stats["trades"],
                    fmt_pct(stats.get("avg_mae")),
                    fmt_pct(stats.get("median_mae")),
                    fmt_pct(stats.get("bad_entry_rate")),
                    fmt_minutes(stats.get("avg_time_to_green")),
                    fmt(stats.get("net_pnl"), 2),
                    fmt_pct(stats.get("win_rate")),
                    fmt(stats.get("avg_entry_efficiency"), 2),
                ]
                for bucket, stats in score_stats.items()
            ],
        )
    )
    lines.append("")
    lines.append(f"- Score alto entra más limpio: `{answers['score_high_enters_cleaner']['answer']}`")
    lines.append(f"- Bucket candidato a bloquear/subir umbral: `{answers['bucket_to_block']}`")
    lines.append(f"- 0.60 parece demasiado bajo para algunos símbolos: `{answers['is_0_60_too_low_for_some_symbols']}`")
    lines.append("")

    lines.append("## 8. Votes 2/3 vs 3/3")
    lines.append(
        markdown_table(
            ["Group", "Trades", "Avg MAE", "Bad Entry Rate", "Avg TTG", "Net PnL", "Win Rate"],
            [
                [
                    group,
                    stats["trades"],
                    fmt_pct(stats.get("avg_mae")),
                    fmt_pct(stats.get("bad_entry_rate")),
                    fmt_minutes(stats.get("avg_time_to_green")),
                    fmt(stats.get("net_pnl"), 2),
                    fmt_pct(stats.get("win_rate")),
                ]
                for group, stats in vote_stats.items()
            ],
        )
    )
    lines.append("")
    lines.append(f"- 3/3 mejora calidad LONG: `{answers['votes_3of3_improves_entry_quality']['LONG']}`")
    lines.append(f"- 3/3 mejora calidad SHORT: `{answers['votes_3of3_improves_entry_quality']['SHORT']}`")
    lines.append(f"- 2/3 entra demasiado temprano: `{answers['votes_2of3_enters_too_early']}`")
    lines.append(f"- SHORT 3/3 es realmente mejor: `{answers['short_3of3_really_better']}`")
    lines.append("")

    lines.append("## 9. Hallazgos principales")
    lines.extend(f"- {item}" for item in report["findings"])
    lines.append("")

    lines.append("## 10. Recomendaciones concretas")
    for item in filters["global_filters"]:
        lines.append(f"- {item['name']} (`{item['priority']}`): {item['proposal']}.")
    lines.append("")
    lines.append("Per-symbol suggested filters:")
    lines.append(
        markdown_table(
            ["Symbol", "Min Score", "Momentum", "3/3", "Reduce Size", "Shadow", "Reason"],
            [
                [
                    symbol,
                    rec["suggested_min_score"],
                    rec["require_momentum_confirm"],
                    rec["require_3of3"],
                    rec["reduce_leverage_or_size"],
                    rec["shadow_only"],
                    rec["reason"],
                ]
                for symbol, rec in filters["per_symbol"].items()
            ],
        )
    )
    lines.append("")

    lines.append("## 11. Propuesta de EntryQualityGate v0.1")
    lines.append("```yaml")
    lines.append("AegisEntryQualityGate_v0_1:")
    lines.append(f"  enabled: {str(gate['enabled']).lower()}")
    lines.append(f"  mode: {gate['mode']}")
    lines.append("  min_score_by_side:")
    for side, score in gate["defaults"]["min_score_by_side"].items():
        lines.append(f"    {side}: {score}")
    lines.append("  require_momentum_confirm: true")
    lines.append("  momentum_confirm:")
    lines.append("    LONG: micro_momentum >= 0")
    lines.append("    SHORT: micro_momentum <= 0")
    lines.append("  max_early_volatility: symbol_recent_atr_pct <= p75")
    lines.append("  anti_falling_knife_lookback_candles: 3")
    lines.append("  max_adverse_recent_return: 0.003")
    lines.append("  overextension_ema_distance_limit: 0.006")
    lines.append("  require_3of3_when_symbol_flagged: true")
    lines.append("  reduce_size_when_symbol_flagged: 0.50")
    if gate["require_3of3_symbols"]:
        lines.append("  require_3of3_symbols:")
        for symbol in gate["require_3of3_symbols"]:
            lines.append(f"    - {symbol}")
    lines.append("```")
    lines.append("")

    lines.append("## 12. Preguntas abiertas para ChatGPT")
    lines.extend(
        [
            "- Should SHORT use a globally higher min_score than LONG, or only per-symbol tightening?",
            "- Should 2/3 entries remain live with momentum confirmation, or move to SHADOW until entry MAE improves?",
            "- What is the correct source for micro_momentum/EMA distance/ATR at execution time so the gate can be audited?",
            "- Should high-score bad entries be handled with anti-overextension rather than score tightening?",
        ]
    )
    lines.append("")

    if not summary_only:
        lines.append("## Per-trade metrics")
        rows = []
        for trade in report["trades"]:
            rows.append(
                [
                    trade["trade_id"],
                    trade["symbol"],
                    trade["side"],
                    trade["status"],
                    trade["quality_label"],
                    fmt_pct(trade["final_roe"]),
                    fmt_pct(trade["mae_roe"]),
                    fmt_minutes(trade["time_to_green_minutes"]),
                    fmt(trade["entry_score"], 3),
                    f"{trade['votes']['long']}/{trade['votes']['short']}/{trade['votes']['neutral']}",
                ]
            )
        lines.append(
            markdown_table(
                ["Trade", "Symbol", "Side", "Status", "Quality", "Final ROE", "MAE", "TTG", "Score", "Votes L/S/N"],
                rows,
            )
        )
        lines.append("")

    lines.append("## Warnings")
    if warnings:
        shown = warnings[:40] if summary_only else warnings
        lines.extend(f"- {warning}" for warning in shown)
        if len(warnings) > len(shown):
            lines.append(f"- ... {len(warnings) - len(shown)} more warnings omitted from summary.")
    else:
        lines.append("- None.")
    lines.append("")
    return "\n".join(lines)


def build_findings(report: dict[str, Any]) -> list[str]:
    findings: list[str] = []
    global_stats = report["global"]
    answers = report["answers"]
    side_stats = report["long_vs_short"]
    score_stats = report["score_buckets"]
    vote_stats = report["votes_quality"]

    findings.append(
        f"Global bad-entry rate is {fmt_pct(global_stats.get('bad_entry_rate'))} with avg MAE {fmt_pct(global_stats.get('avg_mae'))} and net PnL {fmt(global_stats.get('net_pnl'), 2)} USDT."
    )
    if "LONG" in side_stats and "SHORT" in side_stats:
        findings.append(
            f"LONG avg MAE {fmt_pct(side_stats['LONG'].get('avg_mae'))}, SHORT avg MAE {fmt_pct(side_stats['SHORT'].get('avg_mae'))}; SHORT extra filter: {answers['short_needs_extra_filter']}."
        )
    findings.append(
        f"Bad entries tied to low-signal setups: {answers['bad_trades_low_signal']['bad_entries_with_2of3_or_score_below_0_70']}/{answers['bad_trades_low_signal']['bad_entries']}."
    )
    if answers["high_score_bad_entries"]["bad_entries_score_gte_0_80"]:
        findings.append(
            f"High-score setups are not immune: {answers['high_score_bad_entries']['bad_entries_score_gte_0_80']} bad entries had score >= 0.80."
        )
    populated_scores = [f"{bucket}: {stats['trades']} trades, bad {fmt_pct(stats.get('bad_entry_rate'))}" for bucket, stats in score_stats.items() if stats["trades"]]
    if populated_scores:
        findings.append("Score bucket distribution: " + "; ".join(populated_scores) + ".")
    populated_votes = [f"{group}: {stats['trades']} trades, bad {fmt_pct(stats.get('bad_entry_rate'))}" for group, stats in vote_stats.items() if stats["trades"]]
    if populated_votes:
        findings.append("Votes distribution: " + "; ".join(populated_votes) + ".")
    return findings


def strip_internal(metrics: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for metric in metrics:
        clean = {k: v for k, v in metric.items() if not k.startswith("_")}
        out.append(clean)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze local Aegis Turbo entry quality logs.")
    parser.add_argument("--log-dir", default="logs/aegis", help="Directory with Aegis JSONL logs.")
    parser.add_argument("--reports-dir", default="reports", help="Output report directory.")
    parser.add_argument("--dates", nargs="*", help="Specific YYYY-MM-DD dates to analyze.")
    parser.add_argument("--all-recent", action="store_true", help="Analyze all dates available in logs/aegis.")
    args = parser.parse_args()

    root = Path.cwd()
    log_dir = (root / args.log_dir).resolve()
    reports_dir = (root / args.reports_dir).resolve()
    reports_dir.mkdir(parents=True, exist_ok=True)

    dates = select_dates(log_dir, args.dates, args.all_recent)
    warnings: list[str] = []
    if not dates:
        raise SystemExit(f"No JSONL dates found under {log_dir}")

    trades_read = read_jsonl_files(file_paths(log_dir, "turbo_trades", dates))
    events_read = read_jsonl_files(file_paths(log_dir, "turbo_trade_events", dates))
    signals_read = read_jsonl_files(file_paths(log_dir, "turbo_signals", dates))
    snapshots_read = read_jsonl_files(file_paths(log_dir, "account_snapshots", dates))
    for label, read in [
        ("turbo_trades", trades_read),
        ("turbo_trade_events", events_read),
        ("turbo_signals", signals_read),
        ("account_snapshots", snapshots_read),
    ]:
        if read.missing_files:
            warnings.append(f"{label}: {read.missing_files} expected files missing")
        if read.corrupt_lines:
            warnings.append(f"{label}: {read.corrupt_lines} corrupt/non-dict JSONL lines skipped")

    merged_rows, merge_diagnostics = merge_trade_rows(trades_read.rows)
    snapshot_index = build_snapshot_index(snapshots_read.rows)
    trade_metrics_internal, metric_warnings = build_trade_metrics(merged_rows, snapshot_index)
    warnings.extend(metric_warnings)

    start_candidates = [parse_dt(m.get("entry_time")) for m in trade_metrics_internal if m.get("entry_time") != "n/a"]
    end_candidates = [
        parse_dt(m.get("exit_time")) for m in trade_metrics_internal if m.get("exit_time") != "n/a"
    ] + [parse_dt(row.get("timestamp")) for row in snapshots_read.rows]
    start = min([dt for dt in start_candidates if dt is not None], default=None)
    end = max([dt for dt in end_candidates if dt is not None], default=None)

    by_symbol = aggregate_by_symbol(trade_metrics_internal)
    by_side = aggregate_by_side(trade_metrics_internal)
    score_buckets = aggregate_score_buckets(trade_metrics_internal)
    votes_quality = aggregate_votes(trade_metrics_internal)
    answers = answer_questions(by_side, score_buckets, votes_quality, trade_metrics_internal)
    filters = filter_recommendations(by_symbol, by_side)
    gate = entry_quality_gate_v01(filters)

    report: dict[str, Any] = {
        "generated_at": iso(datetime.now(timezone.utc)),
        "period": {
            "dates": dates,
            "start": iso(start),
            "end": iso(end),
        },
        "inputs": {
            "log_dir": str(log_dir),
            "files": {
                "turbo_trades": trades_read.files_read,
                "turbo_trade_events": events_read.files_read,
                "turbo_signals": signals_read.files_read,
                "account_snapshots": snapshots_read.files_read,
            },
            "rows": {
                "turbo_trades": len(trades_read.rows),
                "turbo_trade_events": len(events_read.rows),
                "turbo_signals": len(signals_read.rows),
                "account_snapshots": len(snapshots_read.rows),
            },
            "merge_diagnostics": merge_diagnostics,
        },
        "global": aggregate_metrics(trade_metrics_internal),
        "by_symbol": by_symbol,
        "long_vs_short": by_side,
        "score_buckets": score_buckets,
        "votes_quality": votes_quality,
        "answers": answers,
        "filter_recommendations": filters,
        "entry_quality_gate_v0_1": gate,
        "trades": strip_internal(trade_metrics_internal),
        "warnings": warnings,
    }
    report["findings"] = build_findings(report)

    tag = utc_now_tag()
    json_path = reports_dir / f"aegis_entry_quality_{tag}.json"
    md_path = reports_dir / f"aegis_entry_quality_{tag}.md"
    summary_path = reports_dir / f"aegis_entry_quality_summary_for_chat_{tag}.md"
    json_path.write_text(json.dumps(json_safe(report), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(report, summary_only=False), encoding="utf-8")
    summary_path.write_text(render_markdown(report, summary_only=True), encoding="utf-8")

    print(json.dumps({
        "json": str(json_path),
        "markdown": str(md_path),
        "summary_for_chat": str(summary_path),
        "period": report["period"],
        "trades_analyzed": report["global"]["trades"],
        "closed_trades": report["global"]["closed_trades"],
        "open_trades": report["global"]["open_trades"],
        "warnings": len(warnings),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
