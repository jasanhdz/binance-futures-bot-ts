#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backtest.py – Backtest simple sobre el CSV acumulado + artefactos del modelo.

Lee:
  train/data/raw_klines_{SYMBOL}_{INTERVAL}.csv
  train/data/model_coeffs_{long,short}.json
  train/data/scaler_{long,short}.json

ENV opcionales:
  SYMBOL (default: XRPUSDT)
  INTERVAL (default: 5m)
  THRESH (default: 0.65)
  SL_PCT (default: 0.005)
  TP_PCT (default: 0.010)
  FEE_PCT (default: 0.0006)
  LEVERAGE (default: 100)
"""

import os, json, pathlib
import pandas as pd
import numpy as np

SYMBOL   = os.getenv("SYMBOL", "XRPUSDT")
INTERVAL = os.getenv("INTERVAL", "5m")
THRESH   = float(os.getenv("THRESH", "0.65"))
SL_PCT   = float(os.getenv("SL_PCT", "0.005"))
TP_PCT   = float(os.getenv("TP_PCT", "0.010"))
FEE_PCT  = float(os.getenv("FEE_PCT","0.0006"))
LEVERAGE = float(os.getenv("LEVERAGE","100"))

DATA_DIR = pathlib.Path(__file__).resolve().parent / "data"
RAW_PATH = DATA_DIR / f"raw_klines_{SYMBOL}_{INTERVAL}.csv"

FEATURES = ['rsi','ema_slope','atr_pct','vol_ratio','body_pct','wickiness','mom3','mom12']

def load_model(suffix: str):
    m = json.load(open(DATA_DIR / f"model_coeffs_{suffix}.json"))
    s = json.load(open(DATA_DIR / f"scaler_{suffix}.json"))
    return np.array(m["coefficients"]), float(m["intercept"]), s

def zscore(arr, scaler_dict):
    return [(arr[i] - scaler_dict["mean"][f]) / (scaler_dict["std"][f] or 1e-9)
            for i, f in enumerate(FEATURES)]

def sigmoid(z): return 1 / (1 + np.exp(-z))

def add_features(df: pd.DataFrame) -> pd.DataFrame:
    c = df.copy()
    r = (c['high'] - c['low']).replace(0, 1e-9)
    c['body_pct']  = (c['close'] - c['open']).abs() / r
    c['wickiness'] = ((c['high'] - np.maximum(c['open'], c['close'])) +
                      (np.minimum(c['open'], c['close']) - c['low'])) / r

    tr = np.maximum(c['high'] - c['low'],
                    np.maximum((c['high'] - c['close'].shift(1)).abs(),
                               (c['low'] - c['close'].shift(1)).abs()))
    atr = tr.rolling(14).mean()
    c['atr_pct'] = (atr / c['close']).fillna(0)

    delta = c['close'].diff()
    gain  = delta.clip(lower=0).rolling(14).mean()
    loss  = (-delta).clip(lower=0).rolling(14).mean().replace(0, np.nan)
    rs = gain / loss
    c['rsi'] = (100 - (100 / (1 + rs))).fillna(50)

    ema25 = c['close'].ewm(span=25).mean()
    c['ema_slope'] = ((ema25 - ema25.shift(8)) / ema25.shift(8)).replace([np.inf, -np.inf], 0).fillna(0)

    vol_avg20 = c['volume'].rolling(20).mean().replace(0, np.nan)
    c['vol_ratio'] = (c['volume'] / vol_avg20).fillna(1.0)

    c['mom3']  = c['close'].pct_change(3)
    c['mom12'] = c['close'].pct_change(12)

    c['next_1h_return'] = (c['close'].shift(-12) - c['close']) / c['close']

    return c.dropna().reset_index(drop=True)

def main():
    if not RAW_PATH.exists():
        print("⚠️ No existe el CSV acumulado. Ejecuta primero train/retrain.py")
        return

    raw = pd.read_csv(RAW_PATH)
    for col in ['open','high','low','close','volume']:
        raw[col] = pd.to_numeric(raw[col], errors='coerce')
    raw = raw.dropna().reset_index(drop=True)

    df = add_features(raw)
    if df.empty:
        print("⚠️ No hay datos suficientes para backtest.")
        return

    coef_long,  inter_long,  sc_long  = load_model("long")
    coef_short, inter_short, sc_short = load_model("short")

    X = df[FEATURES].values
    df['prob_long']  = [sigmoid(np.dot(zscore(row, sc_long),  coef_long)  + inter_long)  for row in X]
    df['prob_short'] = [sigmoid(np.dot(zscore(row, sc_short), coef_short) + inter_short) for row in X]

    df['entry_long']  = df['prob_long']  > THRESH
    df['entry_short'] = df['prob_short'] > THRESH

    results = []
    for i, row in df.iterrows():
        if not (row['entry_long'] or row['entry_short']):
            continue

        side        = 'LONG' if row['entry_long'] else 'SHORT'
        entry_price = row['close']
        sl_price    = entry_price * (1 - SL_PCT) if side == 'LONG' else entry_price * (1 + SL_PCT)
        tp_price    = entry_price * (1 + TP_PCT) if side == 'LONG' else entry_price * (1 - TP_PCT)

        future = df.iloc[i+1:i+13]  # 12 velas (1h para 5m)
        if len(future) < 12: break

        pnl, win = 0.0, False
        for _, r in future.iterrows():
            high, low = r['high'], r['low']
            if side == 'LONG':
                if low <= sl_price:
                    pnl = -SL_PCT * LEVERAGE - FEE_PCT * 2
                    break
                if high >= tp_price:
                    pnl =  TP_PCT * LEVERAGE - FEE_PCT * 2
                    win = True
                    break
            else:
                if high >= sl_price:
                    pnl = -SL_PCT * LEVERAGE - FEE_PCT * 2
                    break
                if low <= tp_price:
                    pnl =  TP_PCT * LEVERAGE - FEE_PCT * 2
                    win = True
                    break
        else:
            final_price = future.iloc[-1]['close']
            ret = (final_price - entry_price) / entry_price
            if side == 'SHORT': ret = -ret
            pnl = ret * LEVERAGE - FEE_PCT * 2
            win = pnl > 0

        results.append({'side': side, 'pnl': pnl, 'win': win})

    if not results:
        print("⚠️ No se ejecutó ningún trade en el backtest.")
        return

    res = pd.DataFrame(results)
    for side in ['LONG','SHORT']:
        sub = res[res['side']==side]
        if sub.empty: continue
        print(f"\n📊 {side}")
        print(f"Trades: {len(sub)}")
        print(f"Win rate: {sub['win'].mean():.2%}")
        print(f"Total return: {sub['pnl'].sum():.2f}%")
        dd = (sub['pnl'].cumsum().cummax() - sub['pnl'].cumsum()).max()
        print(f"Max drawdown: {dd:.2f}%")

    print("\n📊 GLOBAL")
    print(f"Total trades: {len(res)}")
    print(f"Win rate: {res['win'].mean():.2%}")
    print(f"Total return: {res['pnl'].sum():.2f}%")
    ddg = (res['pnl'].cumsum().cummax() - res['pnl'].cumsum()).max()
    print(f"Max drawdown: {ddg:.2f}%")

if __name__ == "__main__":
    main()
