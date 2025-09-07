#!/usr/bin/env python3
"""
retrain.py  – entrena y exporta modelos LONG + SHORT
Salida:  data/{model_coeffs,scaler}_{long,short}.{json,pkl}
"""
import pandas as pd
import numpy as np
import json
from binance.client import Client
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegressionCV
from imblearn.over_sampling import RandomOverSampler
from joblib import dump

# ---------- CONFIG ----------
API_KEY    = "06ce79f3b906a3b3e427eb2e39cbcf74e099b85dd456c392b9d58aaab64af20d"
API_SECRET = "4906637f42bb342721ab114ef7b0695d9b53b0fa5a65e7b03f499f34ab9a9382"
SYMBOL     = "XRPUSDT"
INTERVAL   = "5m"
LIMIT      = 15000
FEAT_COLS  = ['rsi','ema_slope','atr_pct','vol_ratio',
              'body_pct','wickiness','mom3','mom12']

client = Client(API_KEY, API_SECRET, testnet=True,
                base_endpoint="https://testnet.binancefuture.com")

# ---------- HELPERS ----------
def fetch(limit):
    klines = client.futures_klines(symbol=SYMBOL, interval=INTERVAL, limit=min(limit, 1500))
    df = pd.DataFrame(klines, columns=[
        'open_time','open','high','low','close','volume',
        'close_time','quote_vol','count','taker_buy_base','taker_buy_quote','ignore'
    ]).iloc[:, :6]
    for col in df.columns[1:6]:
        df[col] = pd.to_numeric(df[col])
    return df

def add_feats(df):
    c = df
    c['body_pct']  = np.abs(c['close'] - c['open']) / (c['high'] - c['low'] + 1e-9)
    c['wickiness'] = ((c['high'] - np.maximum(c['open'], c['close'])) +
                      (np.minimum(c['open'], c['close']) - c['low'])) / (c['high'] - c['low'] + 1e-9)
    c['atr']       = (c['high'] - c['low']).rolling(14).mean()
    c['atr_pct']   = c['atr'] / c['close']
    delta = c['close'].diff()
    gain  = delta.clip(lower=0).rolling(14).mean()
    loss  = (-delta).clip(lower=0).rolling(14).mean()
    rs    = gain / loss
    c['rsi']       = 100 - (100 / (1 + rs))
    c['ema25']     = c['close'].ewm(span=25).mean()
    c['ema_slope'] = (c['ema25'] - c['ema25'].shift(8)) / c['ema25'].shift(8)
    c['vol_ratio'] = c['volume'] / c['volume'].rolling(20).mean()
    c['mom3']      = c['close'].pct_change(3)
    c['mom12']     = c['close'].pct_change(12)
    c['next_1h_return'] = (c['close'].shift(-12) - c['close']) / c['close']
    return c.dropna()

# ---------- ENTRENAR ----------
df = add_feats(fetch(LIMIT))
X = df[FEAT_COLS]

targets = {
    "long":  (df['next_1h_return'] >  0.003).astype(int),
    "short": (df['next_1h_return'] < -0.003).astype(int)
}

def train_and_save(X, y, suffix):
    scaler = StandardScaler()
    X_s = scaler.fit_transform(X)

    ros = RandomOverSampler(sampling_strategy=0.8, random_state=42)
    X_bal, y_bal = ros.fit_resample(X_s, y)

    model = LogisticRegressionCV(
        Cs=np.logspace(-3, 1, 5), cv=5, scoring='f1', max_iter=1000
    ).fit(X_bal, y_bal)

    # ---- JSON para TypeScript ----
    json.dump(
        {"coefficients": model.coef_[0].tolist(), "intercept": float(model.intercept_[0])},
        open(f"data/model_coeffs_{suffix}.json", "w"), indent=2
    )
    # ---- Pickle para Python ----
    dump(scaler, f"data/scaler_{suffix}.pkl")
    # ---- JSON para TypeScript ----
    scaler_json = {
        "mean": {f: float(scaler.mean_[i]) for i, f in enumerate(FEAT_COLS)},
        "std":  {f: float(scaler.scale_[i]) for i, f in enumerate(FEAT_COLS)}
    }
    json.dump(scaler_json, open(f"data/scaler_{suffix}.json", "w"), indent=2)

    print(f"✅ {suffix.upper()} exportado")

for suffix, y in targets.items():
    train_and_save(X, y, suffix)

print("Entrenamiento dual finalizado – archivos en data/")