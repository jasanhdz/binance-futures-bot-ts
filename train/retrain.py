#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
retrain.py – Pipeline Único:
- Mantiene un CSV acumulado de velas (últimos 5 días + append incremental)
- Calcula features
- Entrena modelos LONG/SHORT y exporta artefactos para TypeScript

Requisitos:
  pip install python-binance scikit-learn imbalanced-learn joblib pandas numpy

ENV (opcional):
  SYMBOL=XRPPUSDT   (default: XRPUSDT)
  INTERVAL=5m       (default: 5m)
  IS_TESTNET=1|0    (default: 1)
  DAYS=5            (default: 5)
"""

import os, json, time, math, pathlib
import pandas as pd
import numpy as np
from datetime import datetime, timedelta, timezone
from binance.client import Client
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegressionCV
from imblearn.over_sampling import RandomOverSampler
from joblib import dump
from feats import add_features, FEATURES

# ========= CONFIG =========
SYMBOL   = os.getenv("SYMBOL", "XRPUSDT")
INTERVAL = os.getenv("INTERVAL", "5m")
IS_TEST  = os.getenv("IS_TESTNET", "1") == "1"
DAYS     = int(os.getenv("DAYS", "20"))

DATA_DIR = pathlib.Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
RAW_PATH = DATA_DIR / f"raw_klines_{SYMBOL}_{INTERVAL}.csv"

HTTP_TEST = "https://testnet.binancefuture.com"
HTTP_PROD = "https://fapi.binance.com"

client = Client(
    api_key=os.getenv("BINANCE_API_KEY",""),
    api_secret=os.getenv("BINANCE_API_SECRET",""),
    testnet=IS_TEST,
    base_endpoint=HTTP_TEST if IS_TEST else HTTP_PROD
)

FEAT_COLS = ['rsi','ema_slope','atr_pct','vol_ratio','body_pct','wickiness','mom3','mom12']

# ========= HELPERS =========
def interval_ms(interval: str) -> int:
    unit = interval[-1].lower()
    n = int(interval[:-1])
    if unit == 'm': return n * 60_000
    if unit == 'h': return n * 3_600_000
    if unit == 'd': return n * 86_400_000
    raise ValueError("INTERVAL inválido (usa 1m, 5m, 15m, 1h, etc.)")

def now_ms() -> int:
    return int(time.time() * 1000)

def dt_ms(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)

def fetch_range(symbol: str, interval: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    """Paginea futures_klines hasta traer [start_ms, end_ms)."""
    out = []
    lim = 1500
    cursor = start_ms
    while cursor < end_ms:
        batch = client.futures_klines(
            symbol=symbol,
            interval=interval,
            startTime=cursor,
            endTime=end_ms,
            limit=lim
        )
        if not batch:
            break
        out.extend(batch)
        last_close = int(batch[-1][6])  # close_time
        # cortamos si no avanzó (protege loops)
        step = max(interval_ms(interval), 1)
        cursor = max(last_close + 1, cursor + step)
        # evita superar demasiado el límite API
        if len(batch) < lim:
            break

    if not out:
        return pd.DataFrame(columns=['open_time','open','high','low','close','volume','close_time'])

    df = pd.DataFrame(out, columns=[
        'open_time','open','high','low','close','volume',
        'close_time','quote_vol','count','taker_buy_base','taker_buy_quote','ignore'
    ]).iloc[:, :7]  # nos quedamos hasta close_time
    for c in ['open','high','low','close','volume']:
        df[c] = pd.to_numeric(df[c])
    return df

def ensure_raw_csv(days: int = 5) -> pd.DataFrame:
    """Crea/actualiza el CSV acumulado sin perder histórico (dedupe por open_time)."""
    end = now_ms()
    start_default = end - days * 86_400_000

    if RAW_PATH.exists():
        # cargar histórico y continuar desde la última vela
        hist = pd.read_csv(RAW_PATH)
        # por compatibilidad si columnas vienen en string
        for c in ['open','high','low','close','volume']:
            hist[c] = pd.to_numeric(hist[c], errors='coerce')
        hist = hist.dropna(subset=['open_time','close_time']).copy()
        last_ct = int(hist['close_time'].max())
        start = max(start_default, last_ct + 1)
        print(f"🔄 Actualizando desde {datetime.utcfromtimestamp(start/1000)} UTC ...")
        add = fetch_range(SYMBOL, INTERVAL, start, end)
        if not add.empty:
            all_df = pd.concat([hist, add], ignore_index=True)
        else:
            all_df = hist
    else:
        print(f"⬇️  Descargando histórico inicial ({days} días)...")
        all_df = fetch_range(SYMBOL, INTERVAL, start_default, end)

    if all_df.empty:
        print("⚠️ No se obtuvieron velas.")
        return all_df

    # dedupe + orden
    all_df = all_df.drop_duplicates(subset=['open_time']).sort_values('open_time').reset_index(drop=True)

    # persistir
    all_df.to_csv(RAW_PATH, index=False)
    print(f"✅ RAW actualizado → {RAW_PATH} (filas={len(all_df)})")
    return all_df

def train_and_export(df_feats: pd.DataFrame, suffix: str, feat_cols: list[str]):
    X = df_feats[feat_cols].values
    if suffix == "long":
        y = (df_feats['next_1h_return'] >  0.003).astype(int).values
    else:
        y = (df_feats['next_1h_return'] < -0.003).astype(int).values

    scaler = StandardScaler()
    Xs = scaler.fit_transform(X)

    ros = RandomOverSampler(sampling_strategy=0.8, random_state=42)
    Xb, yb = ros.fit_resample(Xs, y)

    model = LogisticRegressionCV(
        Cs=np.logspace(-3, 1, 5), cv=5, scoring='f1', max_iter=1000, n_jobs=-1
    ).fit(Xb, yb)

    # Artefactos JSON para TypeScript
    json.dump(
        {"coefficients": model.coef_[0].tolist(), "intercept": float(model.intercept_[0])},
        open(DATA_DIR / f"model_coeffs_{suffix}.json", "w"),
        indent=2
    )
    # Scaler .pkl (útil en Python)
    dump(scaler, DATA_DIR / f"scaler_{suffix}.pkl")

    # Scaler JSON para tu bot TS
    scaler_json = {
        "mean": {f: float(scaler.mean_[i]) for i, f in enumerate(feat_cols)},
        "std":  {f: float(scaler.scale_[i]) for i, f in enumerate(feat_cols)}
    }
    json.dump(scaler_json, open(DATA_DIR / f"scaler_{suffix}.json", "w"), indent=2)

    print(f"✅ Modelo {suffix.upper()} exportado")

def main():
    raw = ensure_raw_csv(DAYS)
    if raw.empty or len(raw) < 400:
        print("⚠️ Pocas velas para entrenar. Aborta.")
        return

    feats = add_features(raw)
    if feats.empty:
        print("⚠️ No se pudieron calcular features.")
        return

    print(f"📦 Dataset de entrenamiento: {len(feats)} filas")
    train_and_export(feats, "long",  FEAT_COLS)
    train_and_export(feats, "short", FEAT_COLS)
    print("🎉 Entrenamiento dual finalizado – artefactos en:", DATA_DIR)

if __name__ == "__main__":
    main()
