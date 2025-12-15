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


def round_probabilities(row: Dict[str, Any]) -> None:
    """Round probability fields to 2 decimals."""
    for key, value in list(row.items()).copy():
        if not isinstance(value, float):
            continue
        lower = key.lower()
        if "prob" in lower or "threshold" in lower or lower.endswith("_pnl"):
            row[key] = round(value, 2)


def build_csv_row(timestamp: str, cleaned_ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Build a flat CSV row from the ctx payload."""
    row: Dict[str, Any] = {"date": timestamp}
    
    # Extract top-level fields
    for key in ["symbol", "action", "reason"]:
        if key in cleaned_ctx:
            row[key] = cleaned_ctx[key]
    
    # Extract diagnostics (new ML format)
    diagnostics = cleaned_ctx.get("diagnostics")
    if isinstance(diagnostics, dict):
        for key in ["symbol", "timeframe", "longProb", "shortProb", "threshold"]:
            if key in diagnostics:
                row[key] = diagnostics[key]
        
        # Extract pnl_config if present
        pnl_config = diagnostics.get("pnl_config")
        if isinstance(pnl_config, (int, float)):
            row["pnl_config"] = pnl_config
    
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

    # Define column order for CSV (ML Probability fields)
    desired_order = [
        "date",
        "symbol",
        "timeframe",
        "action",
        "longProb",
        "shortProb",
        "threshold",
        "pnl_config",
        "reason",
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
