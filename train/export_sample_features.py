#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# train/export_sample_features.py
#
# Exporta un sample listo para el checker TS sin necesidad de flags manuales:
# - Incluye SIEMPRE: "window" (prefijo) + "candle" + "features_py"
# - Ventana por defecto: prefijo completo hasta cada fila, con tope 600 (configurable)
#
# ENV opcionales:
#   EXPORT_MAX_WINDOW=600     (cap del tamaño de la ventana enviada)
#   SYMBOL, INTERVAL          (como siempre)

import os, json, argparse, pathlib
import pandas as pd
from feats import add_features, FEATURES

SYMBOL    = os.getenv("SYMBOL", "XRPUSDT")
INTERVAL  = os.getenv("INTERVAL", "5m")
DATA_DIR  = pathlib.Path(__file__).resolve().parent / "data"
CSV       = DATA_DIR / f"raw_klines_{SYMBOL}_{INTERVAL}.csv"
OUT       = DATA_DIR / f"sample_{SYMBOL}_{INTERVAL}.json"

# cap de ventana (prefijo) para no hacer el JSON gigante
MAX_WIN = int(os.getenv("EXPORT_MAX_WINDOW", "600"))

CANDLE_COLS = ["open_time","open","high","low","close","volume","close_time"]

def row_to_candle_dict(r: pd.Series):
    return {
        "openTime":  int(r["open_time"]),
        "open":      float(r["open"]),
        "high":      float(r["high"]),
        "low":       float(r["low"]),
        "close":     float(r["close"]),
        "volume":    float(r["volume"]),
        "closeTime": int(r["close_time"]),
    }

def main(n: int):
    if not CSV.exists():
        raise SystemExit(f"CSV no encontrado: {CSV}")

    raw = pd.read_csv(CSV)

    # Tipos + limpieza mínima (preserva el índice del CSV)
    for c in ["open","high","low","close","volume"]:
        raw[c] = pd.to_numeric(raw[c], errors="coerce")
    raw = raw.dropna(subset=["open","high","low","close","volume"])

    # Recorte de seguridad: últimas 600–800 velas suelen ser más que suficiente
    raw = raw.iloc[-max(MAX_WIN * 2, 600):].copy()

    # === Calcula features preservando índice (coincide 1:1 con Py/TS)
    feats = add_features(raw)  # preserve_index=True por defecto

    # Join por índice → cada fila trae velas + FEATURES
    merged = raw.join(feats[FEATURES], how="inner")

    # Tomar últimas n filas estables
    sample = merged.tail(n)

    out = []
    # Para cada fila, construir ventana "prefijo" hasta ese índice (cap MAX_WIN)
    for idx, r in sample.iterrows():
        # prefijo desde el inicio del DF hasta idx
        wdf = raw.loc[:idx, CANDLE_COLS]
        if len(wdf) > MAX_WIN:
            wdf = wdf.iloc[-MAX_WIN:]
        window = [row_to_candle_dict(x) for _, x in wdf.iterrows()]

        item = {
            "window": window,
            "candle": row_to_candle_dict(r),
            "features_py": { f: float(r[f]) for f in FEATURES },
        }
        out.append(item)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as w:
        json.dump(out, w, indent=2)

    print(f"✅ Exportado {len(out)} filas → {OUT}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20, help="filas finales a exportar (default 20)")
    args = ap.parse_args()
    main(args.n)
