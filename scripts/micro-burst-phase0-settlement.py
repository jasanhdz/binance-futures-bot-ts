"""Read-only local settlement reconstruction. No exchange requests or operational writes."""
import json
import sqlite3
import sys
from decimal import Decimal
from pathlib import Path
from datetime import datetime, timezone


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    paths = list((root / "data/runtime/micro-net-loss").glob("*.sqlite"))
    if len(paths) != 1:
        raise ValueError("Expected exactly one ledger; do not guess account identity")
    connection = sqlite3.connect(paths[0].as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    rows = connection.execute(
        "SELECT trade_id,evidence,result FROM micro_loss_trades "
        "WHERE closed_at>=? AND closed_at<? ORDER BY closed_at",
        (1789689600000, 1789862400000),
    ).fetchall()
    connection.close()
    for trade_id, evidence, result in rows:
        evidence = json.loads(evidence or "{}", parse_float=Decimal)
        result = json.loads(result or "{}", parse_float=Decimal)
        fills = evidence.get("fills", [])
        keys = [(f["symbol"], f["id"]) for f in fills]
        complete = all(evidence.get(k) is True for k in (
            "fillsComplete", "fundingComplete", "exactOrdersFilledAndPositionFlat"))
        # This cohort has no funding; refuse to invent a generic funding schema.
        complete &= bool(fills) and not evidence.get("funding") and len(set(keys)) == len(keys)
        complete &= all(f["commissionAsset"] == "USDT" for f in fills)
        gross = sum((Decimal(str(f["realizedPnlUsdt"])) for f in fills), Decimal(0))
        fees = sum((Decimal(str(f["commission"])) for f in fills), Decimal(0))
        net = gross - fees
        complete &= abs(net - Decimal(str(result.get("netPnlUsdt", "NaN")))) < Decimal("0.00000001")
        orders = []
        for order_id in dict.fromkeys(f["orderId"] for f in fills):
            subset = [f for f in fills if f["orderId"] == order_id]
            quantity = sum(Decimal(str(f["quantity"])) for f in subset)
            price = sum(Decimal(str(f["quantity"])) * Decimal(str(f["price"])) for f in subset) / quantity
            times = [f["eventTimeMs"] for f in subset]
            orders.append({"orderId": order_id, "side": subset[0]["side"],
                           "quantity": str(quantity), "vwap": str(price),
                           "firstFillMs": min(times), "lastFillMs": max(times),
                           "firstFillUtc": datetime.fromtimestamp(min(times)/1000, timezone.utc).isoformat(),
                           "fillIds": [f["id"] for f in subset]})
        complete &= len(orders) == 2 and Decimal(orders[0]["quantity"]) == Decimal(orders[1]["quantity"])
        print(json.dumps({"tradeId": trade_id, "status": "VERIFIED_LOCAL_EVIDENCE" if complete else "NO_EVALUABLE",
                          "gross": str(gross), "fees": str(fees), "funding": "0" if complete else None,
                          "net": str(net) if complete else None, "orders": orders,
                          "source": evidence.get("source")}))
    print(json.dumps({"symbol": "ADAUSDT", "date": "2026-09-18", "status": "NO_EVALUABLE",
                      "reason": "No matching ledger settlement in this window; screenshot is not fills evidence"}))


if __name__ == "__main__":
    main()
