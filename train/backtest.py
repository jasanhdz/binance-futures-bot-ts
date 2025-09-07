#!/usr/bin/env python3
"""
backtest.py
Backtest LONG  + SHORT con modelos dedicados
Requiere en data/:
  model_coeffs_long.json   scaler_long.json
  model_coeffs_short.json  scaler_short.json
  data.csv
"""
import pandas as pd
import numpy as np
import json

# ---------- PARÁMETROS ----------
SL_PCT   = 0.005
TP_PCT   = 0.01
FEE_PCT  = 0.0006
LEVERAGE = 100
THRESH   = 0.65          # threshold de probabilidad
FEATURES = ['rsi','ema_slope','atr_pct','vol_ratio',
            'body_pct','wickiness','mom3','mom12']

# ---------- CARGAR MODELOS ----------
def load_model(suffix: str):
    with open(f"data/model_coeffs_{suffix}.json") as f:
        m = json.load(f)
    with open(f"data/scaler_{suffix}.json") as f:
        s = json.load(f)
    return np.array(m["coefficients"]), m["intercept"], s

coef_long,  inter_long,  scaler_long  = load_model("long")
coef_short, inter_short, scaler_short = load_model("short")

def sigmoid(z): return 1 / (1 + np.exp(-z))

def zscore(arr, scaler_dict):
    return [(arr[i] - scaler_dict["mean"][f]) / scaler_dict["std"][f]
            for i, f in enumerate(FEATURES)]

# ---------- CARGAR DATOS ----------
df = pd.read_csv("data.csv").dropna().reset_index(drop=True)
X = df[FEATURES].values

# ---------- SCORES ----------
df['prob_long']  = [sigmoid(np.dot(zscore(row, scaler_long),  coef_long)  + inter_long)  for row in X]
df['prob_short'] = [sigmoid(np.dot(zscore(row, scaler_short), coef_short) + inter_short) for row in X]

# ---------- SEÑALES ----------
df['entry_long']  = df['prob_long']  > THRESH
df['entry_short'] = df['prob_short'] > THRESH

# ---------- BACKTEST ----------
results = []

for i, row in df.iterrows():
    if not (row['entry_long'] or row['entry_short']):
        continue

    side         = 'LONG' if row['entry_long'] else 'SHORT'
    entry_price  = row['close']
    sl_price     = entry_price * (1 - SL_PCT) if side == 'LONG' else entry_price * (1 + SL_PCT)
    tp_price     = entry_price * (1 + TP_PCT) if side == 'LONG' else entry_price * (1 - TP_PCT)

    future = df.iloc[i+1:i+13]  # 12 velas (1 hora)
    if len(future) < 12:
        continue

    highs = future['high'].values
    lows  = future['low'].values

    pnl, win = 0, False
    for h, l in zip(highs, lows):
        if side == 'LONG':
            if l <= sl_price:
                pnl = -SL_PCT * LEVERAGE - FEE_PCT * 2
                break
            elif h >= tp_price:
                pnl =  TP_PCT * LEVERAGE - FEE_PCT * 2
                win = True
                break
        else:  # SHORT
            if h >= sl_price:
                pnl = -SL_PCT * LEVERAGE - FEE_PCT * 2
                break
            elif l <= tp_price:
                pnl =  TP_PCT * LEVERAGE - FEE_PCT * 2
                win = True
                break
    else:
        final_price = future.iloc[-1]['close']
        ret = (final_price - entry_price) / entry_price
        if side == 'SHORT':
            ret = -ret
        pnl = ret * LEVERAGE - FEE_PCT * 2
        win = pnl > 0

    results.append({
        'side': side,
        'entry_price': entry_price,
        'sl': sl_price,
        'tp': tp_price,
        'pnl': pnl,
        'win': win
    })

# ---------- RESULTADOS ----------
if not results:
    print("⚠️ No se ejecutó ningún trade.")
    exit()

res = pd.DataFrame(results)

for side in ['LONG', 'SHORT']:
    df_side = res[res['side'] == side]
    if df_side.empty:
        continue
    print(f"\n📊 Resultados {side}")
    print(f"Trades: {len(df_side)}")
    print(f"Win rate: {df_side['win'].mean():.2%}")
    print(f"Total return: {df_side['pnl'].sum():.2f}%")
    print(f"Max drawdown: {(df_side['pnl'].cumsum().cummax() - df_side['pnl'].cumsum()).max():.2f}%")

# Global
print("\n📊 GLOBAL")
print(f"Total trades: {len(res)}")
print(f"Win rate: {res['win'].mean():.2%}")
print(f"Total return: {res['pnl'].sum():.2f}%")
print(f"Max drawdown: {(res['pnl'].cumsum().cummax() - res['pnl'].cumsum()).max():.2f}%")