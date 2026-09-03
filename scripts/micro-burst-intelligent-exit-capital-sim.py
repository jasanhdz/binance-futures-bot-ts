#!/usr/bin/env python3
import json, glob, os

INITIAL_CAPITAL = 100.0
POSITION_FRACTION = 0.09

trades = []
journal_dir = "logs/micro-burst/shadow-outcomes"
for f in glob.glob(os.path.join(journal_dir, "*.jsonl")):
    with open(f) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                trades.append(json.loads(line))
            except:
                pass

trades.sort(key=lambda t: t.get("signalAtMs", 0))

capital = INITIAL_CAPITAL
peak_capital = INITIAL_CAPITAL
max_drawdown = 0
wins = 0
losses = 0
breakeven_count = 0
total_pnl = 0
trade_pnls = []

print(f"Capital inicial: $100.00")
print(f"Fraccion por trade: 9% del capital | Leverage: 40x")
print("-" * 95)
print(f"{'#':>3} {'Side':>5} {'Entry':>10} {'Exit':>10} {'Bps':>8} {'PnL':>10} {'Capital':>12} {'Reason'}")
print("-" * 95)

for i, t in enumerate(trades):
    deo = t.get("dynamicExitOutcome")
    if not deo:
        continue

    entry_price = None
    for m in t.get("entryPriceModels", []):
        if m["model"] == "NEXT_TRADE" and m.get("available"):
            entry_price = m["entryPrice"]
            break
    if not entry_price:
        for m in t.get("entryPriceModels", []):
            if m["model"] == "SIGNAL_PRICE" and m.get("available"):
                entry_price = m["entryPrice"]
                break
    if not entry_price:
        continue

    exit_price = deo.get("counterfactualExitPrice", 0)
    exit_reason = deo.get("counterfactualExitReason", "?")
    gross_bps = deo.get("counterfactualGrossBps", 0)

    position_size = capital * POSITION_FRACTION
    leverage = t.get("leverage", 40)
    return_dec = gross_bps / 10000
    pnl = position_size * return_dec * leverage

    capital += pnl
    total_pnl += pnl
    trade_pnls.append(pnl)

    if capital > peak_capital:
        peak_capital = capital
    dd = (peak_capital - capital) / peak_capital * 100
    if dd > max_drawdown:
        max_drawdown = dd

    if pnl > 0:
        wins += 1
    elif pnl < 0:
        losses += 1
    else:
        breakeven_count += 1

    print(f"{i+1:3d} {t['side']:>5} {entry_price:>10.2f} {exit_price:>10.2f} {gross_bps:>+7.2f} {pnl:>+9.4f} {capital:>11.4f} {exit_reason}")

print("-" * 95)
print()
print("=== RESUMEN ===")
print(f"Capital inicial:     ${INITIAL_CAPITAL:.2f}")
print(f"Capital final:       ${capital:.2f}")
print(f"PnL total:           ${total_pnl:+.4f}")
print(f"Retorno total:       {((capital/INITIAL_CAPITAL)-1)*100:+.2f}%")
print()
print(f"Trades ganadores:    {wins}")
print(f"Trades perdedores:   {losses}")
print(f"Trades breakeven:    {breakeven_count}")
total_closed = wins + losses
if total_closed > 0:
    print(f"Win rate:            {wins/total_closed*100:.1f}%")
print()
print(f"Peak capital:        ${peak_capital:.2f}")
print(f"Max drawdown:        {max_drawdown:.2f}%")

gross_wins = sum(p for p in trade_pnls if p > 0)
gross_losses = sum(abs(p) for p in trade_pnls if p < 0)
if gross_losses > 0:
    print(f"Profit factor:       {gross_wins/gross_losses:.2f}")
else:
    print(f"Profit factor:       inf")

print()
print("=== CURVA DE CAPITAL ===")
cap = INITIAL_CAPITAL
print(f"  Inicio: ${cap:.2f}")
for i, t in enumerate(trades):
    deo = t.get("dynamicExitOutcome")
    if not deo:
        continue
    entry_price = None
    for m in t.get("entryPriceModels", []):
        if m["model"] == "NEXT_TRADE" and m.get("available"):
            entry_price = m["entryPrice"]
            break
    if not entry_price:
        continue
    gb = deo.get("counterfactualGrossBps", 0)
    pos = cap * POSITION_FRACTION
    lev = t.get("leverage", 40)
    pnl = pos * (gb / 10000) * lev
    cap += pnl
    if (i+1) % 10 == 0 or i == len(trades) - 1:
        print(f"  Trade #{i+1:2d}: ${cap:.2f} ({((cap/INITIAL_CAPITAL)-1)*100:+.2f}%)")
