#!/usr/bin/env python3
"""
Simulates what would have happened if each blocked Aegis signal had actually entered.

Uses 1m klines from Binance Futures API + exact runtime parameters from YAML config.

Assumptions (documented for reproducibility):
  - Entry price = OPEN of the 1m candle at signal timestamp (slippage ignored)
  - Hard SL = entry * (1 - stop_roe / leverage)  for LONG
              entry * (1 + stop_roe / leverage)  for SHORT  (stop_roe is negative)
  - TP     = entry * (1 + take_profit_roe / leverage) for LONG
              entry * (1 - take_profit_roe / leverage) for SHORT
  - Trailing activation: when unrealized ROE >= trailing_activation_roe
  - Trailing callback:  if peak ROE drops by trailing_callback_roe from max, close
  - Fees: 0.04% taker each side (0.08% round trip)
  - Max hold: 8 hours (28800s)
  - Only 1 position per symbol at a time (first signal wins)
"""

import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ── Runtime parameters (from regime_config.live.yaml) ────────────────────────
LEVERAGE = 15
STOP_ROE = -0.40          # hard stop
TAKE_PROFIT_ROE = 0.50
TRAILING_ACTIVATION_ROE = 0.15
TRAILING_CALLBACK_ROE = 0.08
MAX_HOLD_MS = 28_800_000  # 8 hours
FEE_RATE = 0.0004         # 0.04% taker per side
POSITION_FRACTION = 0.90

# ── Signal extraction ─────────────────────────────────────────────────────────
RESTART_TS = "2026-09-02T18:01:03.333Z"
SIGNALS_PATH = Path("logs/aegis/turbo_signals_2026-09-02.jsonl")

def load_directional_signals():
    """Load all directional signals after restart, deduplicate into unique opportunities."""
    sigs = []
    with SIGNALS_PATH.open(errors="replace") as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("timestamp", "") < RESTART_TS:
                continue
            if r.get("raw_action") in ("LONG", "SHORT"):
                sigs.append(r)

    # Deduplicate: group by (symbol, side, approximate timestamp window)
    # Signals within 60s of each other for same symbol+side are the same opportunity
    opportunities = []
    seen = {}
    for s in sigs:
        key = (s["symbol"], s["raw_action"])
        ts = s["timestamp"]
        if key in seen:
            last_ts, last_idx = seen[key]
            # If within 120s, same window — keep the first one only
            if _ts_diff_ms(last_ts, ts) < 120_000:
                continue
        seen[key] = (ts, len(opportunities))
        opportunities.append(s)

    return sigs, opportunities

def _ts_diff_ms(ts1, ts2):
    from datetime import datetime
    fmt = "%Y-%m-%dT%H:%M:%S"
    t1 = datetime.fromisoformat(ts1.replace("Z", "+00:00"))
    t2 = datetime.fromisoformat(ts2.replace("Z", "+00:00"))
    return abs((t2 - t1).total_seconds() * 1000)


# ── Binance klines ────────────────────────────────────────────────────────────
def fetch_klines(symbol, start_ms, end_ms):
    """Fetch 1m klines from Binance Futures API."""
    all_klines = []
    current = start_ms
    while current < end_ms:
        url = (
            f"https://fapi.binance.com/fapi/v1/klines"
            f"?symbol={symbol}&interval=1m&startTime={current}&endTime={end_ms}&limit=1500"
        )
        for attempt in range(3):
            try:
                r = urllib.request.urlopen(url, timeout=15)
                data = json.loads(r.read())
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  WARNING: Failed to fetch klines for {symbol}: {e}", file=sys.stderr)
                    return all_klines
                time.sleep(1)

        if not data:
            break
        all_klines.extend(data)
        current = data[-1][0] + 60_000  # next candle after last
        time.sleep(0.2)  # rate limit

    return all_klines


# ── Trade simulation ──────────────────────────────────────────────────────────
def simulate_trade(signal, klines_by_symbol):
    """
    Simulate a single trade using 1m candle data.
    Returns dict with outcome details.
    """
    symbol = signal["symbol"]
    side = signal["raw_action"]
    signal_ts = signal["timestamp"]
    leverage = signal.get("leverage", LEVERAGE)
    stop_roe = signal.get("stop_roe", STOP_ROE)
    tp_roe = signal.get("take_profit_roe", TAKE_PROFIT_ROE)
    trail_act = signal.get("trailing_activation_roe", TRAILING_ACTIVATION_ROE)
    trail_cb = signal.get("trailing_callback_roe", TRAILING_CALLBACK_ROE)

    klines = klines_by_symbol.get(symbol, [])
    if not klines:
        return _no_data_result(signal, "no_klines")

    # Find the candle at signal time
    signal_dt = datetime.fromisoformat(signal_ts.replace("Z", "+00:00"))
    signal_epoch_ms = signal_dt.timestamp() * 1000

    entry_idx = None
    for i, k in enumerate(klines):
        if k[0] >= signal_epoch_ms:
            entry_idx = i
            break

    if entry_idx is None:
        return _no_data_result(signal, "signal_after_klines")

    # Entry price = open of the candle at signal time
    entry_price = float(klines[entry_idx][1])

    # SL and TP prices
    if side == "LONG":
        sl_price = entry_price * (1 + stop_roe / leverage)     # stop_roe is negative
        tp_price = entry_price * (1 + tp_roe / leverage)
    else:  # SHORT
        sl_price = entry_price * (1 - stop_roe / leverage)     # flip for short
        tp_price = entry_price * (1 - tp_roe / leverage)

    # Simulate through subsequent candles
    max_hold_candles = MAX_HOLD_MS // 60_000
    peak_roe = 0.0
    trailing_active = False
    exit_price = None
    exit_reason = None
    exit_idx = None

    for j in range(entry_idx + 1, min(entry_idx + 1 + max_hold_candles, len(klines))):
        candle = klines[j]
        candle_high = float(candle[2])
        candle_low = float(candle[3])
        candle_close = float(candle[4])

        if side == "LONG":
            # Check SL (worst case: candle low hits SL)
            pnl_sl = (candle_low - entry_price) / entry_price * leverage
            if pnl_sl <= stop_roe:
                exit_price = sl_price
                exit_reason = "STOP_LOSS"
                exit_idx = j
                break

            # Check TP (best case: candle high hits TP)
            pnl_tp = (candle_high - entry_price) / entry_price * leverage
            if pnl_tp >= tp_roe:
                exit_price = tp_price
                exit_reason = "TAKE_PROFIT"
                exit_idx = j
                break

            # Current ROE using close (percentage)
            current_roe = (candle_close - entry_price) / entry_price * leverage * 100

        else:  # SHORT
            pnl_sl = (entry_price - candle_high) / entry_price * leverage
            if pnl_sl <= stop_roe:
                exit_price = sl_price
                exit_reason = "STOP_LOSS"
                exit_idx = j
                break

            pnl_tp = (entry_price - candle_low) / entry_price * leverage
            if pnl_tp >= tp_roe:
                exit_price = tp_price
                exit_reason = "TAKE_PROFIT"
                exit_idx = j
                break

            current_roe = (entry_price - candle_close) / entry_price * leverage * 100

        # Trailing stop logic (trail_act and trail_cb are fractions, current_roe is %)
        if current_roe > peak_roe:
            peak_roe = current_roe

        if peak_roe >= trail_act * 100:
            trailing_active = True

        if trailing_active:
            drawdown = peak_roe - current_roe
            if drawdown >= trail_cb * 100:
                exit_price = candle_close
                exit_reason = "TRAILING_STOP"
                exit_idx = j
                break

    # If no exit triggered, close at last candle or max hold
    if exit_price is None:
        last_idx = min(entry_idx + max_hold_candles, len(klines) - 1)
        exit_price = float(klines[last_idx][4])
        exit_reason = "MAX_HOLD"
        exit_idx = last_idx

    # Calculate PnL
    if side == "LONG":
        raw_pnl_pct = (exit_price - entry_price) / entry_price
    else:
        raw_pnl_pct = (entry_price - exit_price) / entry_price

    roe = raw_pnl_pct * leverage * 100  # percentage
    fee_cost = FEE_RATE * 2  # round trip (decimal)
    net_roe = (raw_pnl_pct - fee_cost) * leverage * 100  # percentage

    # Duration
    duration_candles = (exit_idx - entry_idx) if exit_idx else 0
    duration_min = duration_candles

    return {
        "outcome": exit_reason,
        "entry_price": entry_price,
        "exit_price": exit_price,
        "side": side,
        "symbol": symbol,
        "roe": round(roe, 4),
        "net_roe": round(net_roe, 4),
        "peak_roe": round(peak_roe, 4),
        "trailing_activated": trailing_active,
        "duration_min": duration_min,
        "signal_ts": signal_ts,
        "leverage": leverage,
        "stop_roe": stop_roe,
        "tp_roe": tp_roe,
    }

def _no_data_result(sig, reason):
    return {
        "outcome": "NO_DATA",
        "entry_price": 0,
        "exit_price": 0,
        "side": sig["raw_action"],
        "symbol": sig["symbol"],
        "roe": 0,
        "net_roe": 0,
        "peak_roe": 0,
        "trailing_activated": False,
        "duration_min": 0,
        "signal_ts": sig["timestamp"],
        "leverage": sig.get("leverage", LEVERAGE),
        "stop_roe": sig.get("stop_roe", STOP_ROE),
        "tp_roe": sig.get("take_profit_roe", TAKE_PROFIT_ROE),
    }


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("=" * 80)
    print("AEGIS BLOCKED SIGNALS — TRADE SIMULATION")
    print("=" * 80)
    print()

    # 1. Load signals
    all_sigs, opportunities = load_directional_signals()
    print(f"Total directional signals: {len(all_sigs)}")
    print(f"Unique opportunities (deduplicated): {len(opportunities)}")
    print()

    # 2. Group by symbol to fetch klines once
    symbols = list({s["symbol"] for s in opportunities})
    time_range = (
        min(s["timestamp"] for s in opportunities),
        "2026-09-02T20:15:00Z",  # a bit after last signal
    )
    start_dt = datetime.fromisoformat(time_range[0].replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(time_range[1].replace("Z", "+00:00"))
    start_ms = int(start_dt.timestamp() * 1000) - 60_000  # 1 candle before first signal
    end_ms = int(end_dt.timestamp() * 1000)

    print(f"Time window: {time_range[0]} → {time_range[1]}")
    print(f"Symbols: {symbols}")
    print()

    print("Fetching 1m klines from Binance Futures...")
    klines_by_symbol = {}
    for sym in symbols:
        klines_by_symbol[sym] = fetch_klines(sym, start_ms, end_ms)
        print(f"  {sym}: {len(klines_by_symbol[sym])} candles")
    print()

    # 3. Simulate each opportunity
    results = []
    for sig in opportunities:
        result = simulate_trade(sig, klines_by_symbol)
        results.append(result)

    # 4. Report
    print("=" * 80)
    print("RESULTS PER OPPORTUNITY")
    print("=" * 80)
    print()

    for i, r in enumerate(results, 1):
        emoji = "✅" if r["net_roe"] > 0 else "❌"
        trail = "TRAIL" if r["trailing_activated"] else "no-trail"
        print(
            f"  {i:2d}. {r['symbol']:10s} {r['side']:5s} | "
            f"entry={r['entry_price']:.5f} exit={r['exit_price']:.5f} | "
            f"ROE={r['roe']:+.2f}% netROE={r['net_roe']:+.2f}% | "
            f"{r['outcome']:15s} {trail} | "
            f"peak={r['peak_roe']:.2f}% dur={r['duration_min']}min {emoji}"
        )
    print()

    # 5. Summary
    outcomes = {}
    for r in results:
        outcomes[r["outcome"]] = outcomes.get(r["outcome"], 0) + 1

    wins = sum(1 for r in results if r["net_roe"] > 0)
    losses = sum(1 for r in results if r["net_roe"] <= 0)
    total_net_roe = sum(r["net_roe"] for r in results)
    avg_net_roe = total_net_roe / len(results) if results else 0
    max_gain = max(r["net_roe"] for r in results) if results else 0
    max_loss = min(r["net_roe"] for r in results) if results else 0

    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print(f"  Total opportunities:    {len(results)}")
    print(f"  Outcomes:               {outcomes}")
    print(f"  Wins / Losses:          {wins} / {losses}")
    print(f"  Win rate:               {wins/len(results)*100:.1f}%")
    print(f"  Total net ROE:          {total_net_roe:+.2f}%")
    print(f"  Avg net ROE per trade:  {avg_net_roe:+.2f}%")
    print(f"  Best trade:             {max_gain:+.2f}%")
    print(f"  Worst trade:            {max_loss:+.2f}%")
    print(f"  Trailing activated:     {sum(1 for r in results if r['trailing_activated'])}/{len(results)}")
    print()

    # Per-symbol breakdown
    print("BY SYMBOL:")
    for sym in symbols:
        sym_results = [r for r in results if r["symbol"] == sym]
        sym_wins = sum(1 for r in sym_results if r["net_roe"] > 0)
        sym_net = sum(r["net_roe"] for r in sym_results)
        sym_outcomes = {}
        for r in sym_results:
            sym_outcomes[r["outcome"]] = sym_outcomes.get(r["outcome"], 0) + 1
        print(f"  {sym:10s}: {len(sym_results)} trades, {sym_wins} wins, net={sym_net:+.2f}%, outcomes={sym_outcomes}")
    print()

    # Per-side breakdown
    print("BY SIDE:")
    for side in ["LONG", "SHORT"]:
        side_results = [r for r in results if r["side"] == side]
        if not side_results:
            continue
        side_wins = sum(1 for r in side_results if r["net_roe"] > 0)
        side_net = sum(r["net_roe"] for r in side_results)
        print(f"  {side:5s}: {len(side_results)} trades, {side_wins} wins, net={side_net:+.2f}%")
    print()

    # Detailed trailing analysis
    print("=" * 80)
    print("TRAILING STOP ANALYSIS")
    print("=" * 80)
    for i, r in enumerate(results, 1):
        if r["trailing_activated"]:
            print(f"  {i:2d}. {r['symbol']:10s} {r['side']:5s} | peak={r['peak_roe']:.2f}% → exit at {r['net_roe']:+.2f}% ({r['outcome']})")
    no_trail = [r for r in results if not r["trailing_activated"]]
    if no_trail:
        print(f"\n  {len(no_trail)} trades never activated trailing:")
        for r in no_trail:
            print(f"    {r['symbol']:10s} {r['side']:5s} | peak={r['peak_roe']:.2f}% → {r['outcome']}")


if __name__ == "__main__":
    main()
