# Micro Historical External Migration

The eight historical symbol guards were retired operationally, not economically.
The migration is limited to `SOLUSDT`, `SUIUSDT`, `LINKUSDT`, `BNBUSDT`,
`LTCUSDT`, `AVAXUSDT`, `XRPUSDT`, and `DOGEUSDT`.

The command is dry-run by default. Applying requires a plan created by the same
code and a fresh read-only account audit:

```bash
npm run micro-burst:migrate-historical-external -- \
  --evidence /path/to/unmanaged_live_read_only_account_audit.json \
  --output /tmp/micro-historical-migration-plan.json

npm run micro-burst:migrate-historical-external -- \
  --evidence /path/to/unmanaged_live_read_only_account_audit.json \
  --plan /tmp/micro-historical-migration-plan.json --apply
```

The tool refuses active positions, open regular/algo orders, journal locks,
target-symbol journal activity, changed state hashes, and non-external/non-IDLE
states. It archives each prior state and the evidence before atomically writing
the new state. Re-running an applied plan fails closed.

The migration records `HISTORICAL_EXTERNAL_STATE_RETIRED_BY_OPERATOR`, preserves
`EXTERNAL`/`MANUAL_EXTERNAL`, leaves `eligibleForBotMetrics=false`, and records
`historicalAccountingStatus=UNRESOLVED`. It does not invent identity, PnL,
funding, fills, or stop history, and it does not modify journals or risk counters.
