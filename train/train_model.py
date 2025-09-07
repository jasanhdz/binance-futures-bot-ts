#!/usr/bin/env python3
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
LIMIT      = 10000
FEAT_COLS  = ['rsi','ema_slope','atr_pct','vol_ratio',
              'body_pct','wickiness','mom3','mom12']

client = Client(API_KEY, API_SECRET, testnet=True,
                base_endpoint="https://testnet.binancefuture.com")

# ---------- HELPERS ----------
def fetch(limit):
    klines = client.futures_klines(symbol=SYMBOL, interval=INTERVAL, limit=min(limit,1500))
    df = pd.DataFrame(klines, columns=[
        'open_time','open','high','low','close','volume',
        'close_time','quote_vol','count','taker_buy_base','taker_buy_quote','ignore'
    ]).iloc[:,:6]
    for col in df.columns[1:6]:
        df[col] = pd.to_numeric(df[col])
    return df

def add_indicators(df):
    df['body_pct']  = np.abs(df['close'] - df['open']) / (df['high'] - df['low'] + 1e-9)
    df['wickiness'] = ((df['high'] - np.maximum(df['open'], df['close'])) +
                       (np.minimum(df['open'], df['close']) - df['low'])) / (df['high'] - df['low'] + 1e-9)
    df['atr']       = (df['high'] - df['low']).rolling(14).mean()
    df['atr_pct']   = df['atr'] / df['close']
    df['rsi']       = rsi(df['close'], 14)
    df['ema25']     = df['close'].ewm(span=25).mean()
    df['ema_slope'] = (df['ema25'] - df['ema25'].shift(8)) / df['ema25'].shift(8)
    df['vol_ratio'] = df['volume'] / df['volume'].rolling(20).mean()
    df['mom3']      = df['close'].pct_change(3)
    df['mom12']     = df['close'].pct_change(12)
    df['next_1h_return'] = (df['close'].shift(-12) - df['close']) / df['close']
    return df.dropna()

def rsi(series, period=14):
    delta = series.diff()
    gain  = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss  = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs    = gain / loss
    return 100 - (100 / (1 + rs))

# ---------- ENTRENAR ----------
df = add_indicators(fetch(LIMIT))
X = df[FEAT_COLS]

# LONG -> target positivo
y_long  = (df['next_1h_return'] >  0.003).astype(int)
# SHORT -> target negativo
y_short = (df['next_1h_return'] < -0.003).astype(int)

def train_and_save(X, y, suffix):
    scaler = StandardScaler()
    X_s = scaler.fit_transform(X)

    ros = RandomOverSampler(sampling_strategy=0.8, random_state=42)
    X_bal, y_bal = ros.fit_resample(X_s, y)

    model = LogisticRegressionCV(
        Cs=np.logspace(-3, 1, 5), cv=5, scoring='f1', max_iter=1000
    ).fit(X_bal, y_bal)

    # Guardar coeficientes
    json.dump(
        {"coefficients": model.coef_[0].tolist(), "intercept": float(model.intercept_[0])},
        open(f"data/model_coeffs_{suffix}.json", "w"), indent=2
    )

    # Guardar scaler Pickle
    dump(scaler, f"data/scaler_{suffix}.pkl")

    # Guardar scaler JSON para TypeScript
    scaler_json = {
        "mean": {f: float(scaler.mean_[i]) for i, f in enumerate(FEAT_COLS)},
        "std":  {f: float(scaler.scale_[i]) for i, f in enumerate(FEAT_COLS)}
    }
    json.dump(scaler_json, open(f"data/scaler_{suffix}.json", "w"), indent=2)

    print(f"✅ {suffix.upper()} guardado")

train_and_save(X, y_long,  "long")
train_and_save(X, y_short, "short")

print("Entrenamiento dual finalizado.")