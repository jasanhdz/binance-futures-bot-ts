# feats.py
# -*- coding: utf-8 -*-
import numpy as np
import pandas as pd

FEATURES = ['rsi','ema_slope','atr_pct','vol_ratio','body_pct','wickiness','mom3','mom12']

def add_features(df: pd.DataFrame, *, preserve_index: bool = True) -> pd.DataFrame:
    """
    Calcula features y, por defecto, preserva el índice del df de entrada.
    Si algún consumidor necesita índices 0..N-1 continuos, use preserve_index=False.
    """
    c = df.copy()

    # Tipos seguros
    for col in ['open','high','low','close','volume']:
        c[col] = pd.to_numeric(c[col], errors='coerce')
    c = c.dropna(subset=['open','high','low','close','volume'])

    # Body & wickiness
    r = (c['high'] - c['low']).replace(0, 1e-9)
    c['body_pct']  = (c['close'] - c['open']).abs() / r
    c['wickiness'] = ((c['high'] - np.maximum(c['open'], c['close'])) +
                      (np.minimum(c['open'], c['close']) - c['low'])) / r

    # ATR% (TR clásico, SMA 14)
    prev_close = c['close'].shift(1)
    tr = np.maximum(c['high'] - c['low'],
                    np.maximum((c['high'] - prev_close).abs(),
                               (c['low']  - prev_close).abs()))
    atr = tr.rolling(14).mean()
    c['atr_pct'] = (atr / c['close']).fillna(0.0)

    # RSI 14 (SMA de ganancias/pérdidas), fill=50 si avgLoss=0
    delta = c['close'].diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta).clip(lower=0).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    c['rsi'] = rsi.fillna(50.0)

    # EMA25 + pendiente 8 velas (ajusta a EMA recursiva clásica)
    ema25 = c['close'].ewm(span=25, adjust=False).mean()
    c['ema_slope'] = ((ema25 - ema25.shift(8)) / ema25.shift(8)).replace([np.inf, -np.inf], 0).fillna(0)

    # Volumen relativo 20
    vol_avg20 = c['volume'].rolling(20).mean()
    c['vol_ratio'] = (c['volume'] / vol_avg20).replace([np.inf, -np.inf], 1.0).fillna(1.0)

    # Momentums
    c['mom3']  = c['close'].pct_change(3)
    c['mom12'] = c['close'].pct_change(12)

    # Label auxiliar (opcional)
    c['next_1h_return'] = (c['close'].shift(-12) - c['close']) / c['close']

    out = c.dropna()
    return out if preserve_index else out.reset_index(drop=True)
