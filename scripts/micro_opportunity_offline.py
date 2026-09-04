#!/usr/bin/env python3
"""Deterministic offline scaffolding for Micro Opportunity M/N/O.

Input is versioned JSONL. Rows need ``features`` and valid horizon labels.
The command refuses training when fewer than MIN_TRAIN_ROWS are available.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from statistics import mean
from typing import Any

MIN_TRAIN_ROWS = 100
COSTS_BPS = (14, 20, 30)


def load_dataset(path: Path, horizon: str) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            labels = row.get("labels", row.get("label"))
            label = labels.get(horizon) if isinstance(labels, dict) else labels
            if not isinstance(row.get("features"), dict) or not isinstance(label, dict) or label.get("valid") is not True:
                continue
            outcome = label.get("long") if row.get("orientation", "LONG") == "LONG" else label.get("short")
            if not isinstance(outcome, dict):
                continue
            row["_mfe"] = float(outcome["mfeBps"])
            row["_mae"] = float(outcome["maeBps"])
            row["_positive"] = float(outcome["finalReturnBps"]) - 14 > 0
            row["_time"] = int(row.get("sampledAtMs", row.get("sampled_at_ms", line_number)))
            rows.append(row)
    return sorted(rows, key=lambda item: item["_time"])


def temporal_split(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cut = max(1, int(len(rows) * 0.8))
    return rows[:cut], rows[cut:]


def numeric_features(rows: list[dict[str, Any]]) -> tuple[list[list[float]], list[int], list[str]]:
    names = sorted({name for row in rows for name in row["features"]})
    categories = {name: {} for name in names}
    vectors = []
    for row in rows:
        vector = []
        for name in names:
            value = row["features"].get(name)
            if isinstance(value, (int, float)) and math.isfinite(value):
                vector.append(float(value))
            elif value is None:
                vector.append(0.0)
            else:
                mapping = categories[name]
                vector.append(float(mapping.setdefault(str(value), len(mapping) + 1)))
        vectors.append(vector)
    return vectors, [int(row["_positive"]) for row in rows], names


def baseline_probability(row: dict[str, Any]) -> float:
    features = row["features"]
    score = 0.35 * math.tanh(float(features.get("momentumStrength") or 0))
    score += 0.3 * float(features.get("takerImbalance") or 0)
    score += 0.2 * float(features.get("signedBookImbalance") or 0)
    score += 0.15 * min(float(features.get("corridorWidthBps") or 0) / 100, 1)
    return 1 / (1 + math.exp(-3 * score))


def baseline_candidates(row: dict[str, Any]) -> dict[str, float]:
    features = row["features"]
    momentum = float(features.get("momentumStrength") or 0)
    flow = float(features.get("takerImbalance") or 0)
    book = float(features.get("signedBookImbalance") or 0)
    room = float(features.get("corridorWidthBps") or 0)
    return {
        "momentum_threshold": float(momentum >= 0.5),
        "flow_book_threshold": float(flow >= 0.2 and book >= 0.1),
        "room_risk_score": float(room >= 20 and float(features.get("spreadBps") or 999) <= 5),
        "combined_score": baseline_probability(row),
    }


def score_rows(rows: list[dict[str, Any]], scorer: Any) -> dict[str, float]:
    if not rows:
        return {"count": 0, "accuracy": 0, "mean_net_bps": 0}
    predictions = [scorer(row) >= 0.5 for row in rows]
    actual = [bool(row["_positive"]) for row in rows]
    nets = [row["_mfe"] - 14 if prediction else 0 for row, prediction in zip(rows, predictions)]
    return {"count": len(rows), "accuracy": mean(p == a for p, a in zip(predictions, actual)), "mean_net_bps": mean(nets)}


def bootstrap_ci(values: list[float], iterations: int = 1000) -> tuple[float, float]:
    if not values:
        return (0.0, 0.0)
    means = [mean(values[(i * 997 + j * 101) % len(values)] for j in range(len(values))) for i in range(iterations)]
    means.sort()
    return means[int(iterations * 0.025)], means[int(iterations * 0.975) - 1]


def train_optional_models(train: list[dict[str, Any]], artifact_dir: Path | None) -> dict[str, Any]:
    if artifact_dir is None:
        return {"status": "NOT_REQUESTED"}
    x, y, feature_names = numeric_features(train)
    result: dict[str, Any] = {"feature_names": feature_names, "logistic": "UNAVAILABLE", "lightgbm": "UNAVAILABLE"}
    artifact_dir.mkdir(parents=True, exist_ok=True)
    try:
        from sklearn.linear_model import LinearRegression, LogisticRegression
        import joblib
        model = LogisticRegression(random_state=17, max_iter=500).fit(x, y)
        target = artifact_dir / "logistic_baseline.joblib"
        joblib.dump(model, target)
        result["logistic"] = {"path": str(target), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
        for target_name in ("mfe", "mae"):
            regression = LinearRegression().fit(x, [row[f"_{target_name}"] for row in train])
            target = artifact_dir / f"linear_{target_name}_baseline.joblib"
            joblib.dump(regression, target)
            result[f"linear_{target_name}"] = {"path": str(target), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
    except ImportError:
        pass
    try:
        import lightgbm as lgb
        model = lgb.LGBMClassifier(random_state=17, verbosity=-1)
        model.fit(x, y)
        target = artifact_dir / "lightgbm_v1.txt"
        model.booster_.save_model(str(target))
        result["lightgbm"] = {"path": str(target), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
        for target_name in ("mfe", "mae"):
            regression = lgb.LGBMRegressor(random_state=17, verbosity=-1)
            regression.fit(x, [row[f"_{target_name}"] for row in train])
            target = artifact_dir / f"lightgbm_{target_name}_v1.txt"
            regression.booster_.save_model(str(target))
            result[f"lightgbm_{target_name}"] = {"path": str(target), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
    except ImportError:
        pass
    metadata = artifact_dir / "metadata.json"
    metadata.write_text(json.dumps({"schema": "MICRO_OPPORTUNITY_FEATURE_V1", "train_rows": len(train), "feature_names": feature_names, "models": result}, indent=2, sort_keys=True), encoding="utf-8")
    result["metadata"] = {"path": str(metadata), "sha256": hashlib.sha256(metadata.read_bytes()).hexdigest()}
    return result


def evaluate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    train, test = temporal_split(rows)
    result: dict[str, Any] = {"rows": len(rows), "train": len(train), "test": len(test), "costs_bps": COSTS_BPS}
    result["stable_micro_baseline"] = score_rows(test, lambda row: 1.0 if row.get("population") == "ENTRY_INTENT" else 0.0)
    result["non_ml_baselines"] = {
        name: score_rows(test, lambda row, candidate=name: baseline_candidates(row)[candidate])
        for name in ("momentum_threshold", "flow_book_threshold", "room_risk_score", "combined_score")
    }
    result["slices"] = {key: {value: score_rows([row for row in test if row.get(key) == value], baseline_probability) for value in sorted({row.get(key) for row in test if row.get(key) is not None})} for key in ("symbol", "orientation", "microRegime")}
    result["bootstrap_ci_net_bps"] = {str(cost): bootstrap_ci([row["_mfe"] - cost for row in test]) for cost in COSTS_BPS}
    result["feature_hash"] = hashlib.sha256("\n".join(sorted(test[0]["features"])).encode()).hexdigest() if test else None
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--horizon", default="10000")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--artifact-dir", type=Path)
    args = parser.parse_args()
    rows = load_dataset(args.dataset, args.horizon)
    if len(rows) < MIN_TRAIN_ROWS:
        print(json.dumps({"status": "BLOCKED_INSUFFICIENT_DATA", "valid_rows": len(rows), "minimum_rows": MIN_TRAIN_ROWS}, indent=2))
        return 2
    report = evaluate(rows)
    train, _ = temporal_split(rows)
    report["models"] = train_optional_models(train, args.artifact_dir)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps({"status": "READY_FOR_MODEL_TRAINING", "report": report}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
