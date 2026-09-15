# Micro Historical Audit Tools

These tools collect evidence only. They never edit journals, state files, orders,
positions, or protection.

## Local Binance export

Use the export analyzer without credentials or network access:

```bash
npm run micro-burst:audit-historical-export -- /path/to/binance-export.json
```

JSON arrays and common objects containing `orders`, `trades`, `income`, `data`, or
`rows` are supported. CSV headers are also accepted. The report identifies rows
for the eight quarantined symbols and lists order/client IDs available for exact
follow-up.

## Historical GET-only audit

This command makes four authenticated GET requests per symbol, with a bounded
time window. It uses only `allOrders`, `userTrades`, `income`, and
`allAlgoOrders`; it does not retry and rejects redirects or non-GET transport.

```bash
npm run micro-burst:audit-historical-get -- \
  SOLUSDT,SUIUSDT,LINKUSDT,BNBUSDT,LTCUSDT,AVAXUSDT,XRPUSDT,DOGEUSDT \
  2026-05-01T00:00:00.000Z 2026-09-15T00:00:00.000Z \
  /tmp/micro-historical-get-audit
```

The output is private evidence under the selected directory. Review the JSON
before any operator reconciliation. A flat account observation alone is not
enough to clear a historical ambiguity.
