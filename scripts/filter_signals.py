#!/usr/bin/env python3
"""
Extrae ctx de señales ENTER_LONG / ENTER_SHORT y las exporta a JSONL y CSV.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List

ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")
TARGET_ACTIONS = {"ENTER_LONG", "ENTER_SHORT"}
RE_REASON_TIMEFRAME = re.compile(
    r"^(?P<tf>[0-9]+[smhd])\s+long=(?P<long>-?\d+(?:\.\d+)?)\s*/\s*short=(?P<short>-?\d+(?:\.\d+)?)$"
)


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filtra logs de Binance futures bot y exporta los ctx relevantes."
    )
    parser.add_argument(
        "--date",
        required=True,
        help="Fecha (YYYY-MM-DD) para history-YYYY-MM-DD.log.",
    )
    default_logs = Path(__file__).resolve().parents[1] / "logs"
    parser.add_argument(
        "--log-dir",
        default=default_logs,
        type=Path,
        help=f"Directorio con los history-*.log (por defecto: {default_logs}).",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        type=Path,
        help="Directorio de salida; por defecto usa el directorio de logs.",
    )
    parser.add_argument(
        "--baseline",
        default="history-{date}.log",
        help="Plantilla para el nombre del archivo origen (usa {date}).",
    )
    return parser.parse_args(argv)


def strip_ansi(value: Any) -> Any:
    if isinstance(value, str):
        return ANSI_ESCAPE_RE.sub("", value)
    if isinstance(value, list):
        return [strip_ansi(item) for item in value]
    if isinstance(value, dict):
        return {key: strip_ansi(val) for key, val in value.items()}
    return value


def to_number(value: str) -> Any:
    try:
        return float(value)
    except ValueError:
        return value


def normalize_key(raw: str) -> str:
    token = raw.strip().lower().replace(" ", "_")
    token = re.sub(r"[^a-z0-9_]+", "_", token)
    token = re.sub(r"_+", "_", token).strip("_")
    return token or raw


def parse_reason(reason: str) -> Dict[str, Any]:
    fields: Dict[str, Any] = {}
    if not reason:
        return fields

    parts = [segment.strip() for segment in reason.split("|")]
    tag_count = 0
    for index, part in enumerate(parts):
        if not part:
            continue

        match = RE_REASON_TIMEFRAME.match(part)
        if match:
            tf = match.group("tf")
            long_val = to_number(match.group("long"))
            short_val = to_number(match.group("short"))
            fields[f"{tf}_long"] = long_val
            fields[f"{tf}_short"] = short_val
            continue

        if "=" in part:
            key, value = part.split("=", 1)
            key_norm = normalize_key(key)
            fields[key_norm] = to_number(value.strip())
            continue

        tag_key = "tag" if "tag" not in fields else f"tag_{tag_count}"
        fields[tag_key] = part
        tag_count += 1

    return fields


def round_probabilities(row: Dict[str, Any]) -> None:
    for key, value in list(row.items()):
        if not isinstance(value, float):
            continue
        lower = key.lower()
        if "prob" in lower or lower.endswith("_long") or lower.endswith("_short"):
            row[key] = round(value, 2)


def add_reason_field(row: Dict[str, Any], key: str, value: Any) -> None:
    if key in row and row[key] == value:
        return
    if key in row:
        suffix = 1
        candidate = f"{key}_reason"
        while candidate in row and row[candidate] != value:
            suffix += 1
            candidate = f"{key}_reason{suffix}"
        row[candidate] = value
    else:
        row[key] = value


def build_csv_row(timestamp: str, cleaned_ctx: Dict[str, Any]) -> Dict[str, Any]:
    row: Dict[str, Any] = {"date": timestamp}
    for key, value in cleaned_ctx.items():
        if key == "diagnostics":
            if isinstance(value, dict):
                for metric in ("emaBase", "atr", "rsi", "bodyRatio"):
                    if metric in value:
                        row[metric] = value[metric]
            continue
        if key == "reason" and isinstance(value, str):
            reason_fields = parse_reason(value)
            for reason_key, reason_val in reason_fields.items():
                add_reason_field(row, reason_key, reason_val)
            continue
        row[key] = value
    round_probabilities(row)
    return row


def load_log_lines(path: Path) -> Iterable[str]:
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            cleaned = line.strip()
            if cleaned:
                yield cleaned


def main(argv: Iterable[str] = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    log_dir = args.log_dir.resolve()
    output_dir = (args.output_dir or log_dir).resolve()
    log_path = log_dir / args.baseline.format(date=args.date)

    if not log_path.exists():
        sys.exit(f"No se encontró el archivo: {log_path}")

    output_dir.mkdir(parents=True, exist_ok=True)

    ctx_payloads: List[Dict[str, Any]] = []
    csv_rows: List[Dict[str, Any]] = []

    for raw in load_log_lines(log_path):
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue

        ctx = record.get("ctx")
        if not isinstance(ctx, dict):
            continue

        if ctx.get("action") not in TARGET_ACTIONS:
            continue

        cleaned_ctx = strip_ansi(ctx)
        ctx_payloads.append(cleaned_ctx)

        csv_row = build_csv_row(record.get("ts", ""), cleaned_ctx)
        csv_rows.append(csv_row)

    if not ctx_payloads:
        print("No se encontraron señales con action=ENTER_LONG/ENTER_SHORT.", file=sys.stderr)
        return

    jsonl_path = output_dir / f"ctx_signals-{args.date}.jsonl"
    with jsonl_path.open("w", encoding="utf-8") as handle:
        for payload in ctx_payloads:
            handle.write(json.dumps(payload, ensure_ascii=False))
            handle.write("\n")

    desired_order = [
        "date",
        "symbol",
        "action",
        "5m_long",
        "5m_short",
        "15m_long",
        "15m_short",
        "score",
        "tag",
        "mode",
        "emaBase",
        "atr",
        "rsi",
        "bodyRatio",
    ]
    all_fields = {key for row in csv_rows for key in row.keys()}
    remaining = [field for field in sorted(all_fields) if field not in desired_order]
    fieldnames = desired_order + remaining
    csv_path = output_dir / f"ctx_signals-{args.date}.csv"

    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in csv_rows:
            writer.writerow(row)

    print(f"Procesadas {len(ctx_payloads)} señales.")
    print(f"JSONL: {jsonl_path}")
    print(f"CSV: {csv_path}")


if __name__ == "__main__":
    main()
