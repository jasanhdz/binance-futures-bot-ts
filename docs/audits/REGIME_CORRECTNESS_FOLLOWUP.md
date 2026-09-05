# Regime correctness follow-up

Base: 81022c7251364837137206a34c0364773c3cdf85.
Target: work/micro-burst-rider-v1-20260826 (no new remote branch).

## Corrected contracts

- Missing regime configuration returns UNKNOWN before consulting score or setup.
  OFF stays disabled, SHADOW reports only, ENFORCE denies in the orchestrator.
- The workflow no longer interprets wouldBlock telemetry as an execution veto.
  **Deployment changes SHORT behavior when regime is SHADOW:** it no longer blocks
  by itself. The checked-in YAML is unchanged. Any enforcement rollout requires
  a separate explicit configuration decision, not an implicit shadow override.
- Both technical components share Wilder ADX with full warmup. Period-2 reference
  arithmetic yields 33.3333333333 then 16.6666666667 for the test fixture.
  Undefined ADX no longer grants momentum permission in the context adapter.
- V2 rejects invalid OHLCV, timestamps, gaps, duplicates and arrival-order errors.
  No silent sorting, removal or deduplication. Invalid dates return UNKNOWN, not an exception.
- Outcomes require every five-minute bar of their horizon. Invalid or incomplete
  outcomes have no returns, excursions or barrier labels. Metrics exclude these
  outcomes and expose candidate/incomplete counts. Missing MAE is not treated as zero.
- Walk-forward summaries use complete 60-minute outcomes and exclude observations
  whose outcome crosses the window boundary. These summaries do not train a model.

## Validation and limits

Regression coverage includes high-score missing context, real SHORT execution-port
spies for OFF/SHADOW/ENFORCE, Wilder arithmetic and warmup, invalid first/last candles,
invalid dates, duplicates, order, gaps and incomplete-outcome metric exclusion.
All exchange calls in integration tests are mocks. No runtime was started.

Validation: TypeScript build passes. Expanded selection: 202 passed, 2 failed
(204 tests across 10 files). The two existing failures are the unverified-close
quarantine log assertion and immediate-close-on-bracket-validation assertion in
TradingService.aegis-live.test.ts. The three new SHORT mode integration tests pass.

This is a correctness repair, not evidence of profitability or live readiness.
The legacy guard still classifies signal compatibility; it is not V2 technical
regime detection. Confidence remains heuristic, not a calibrated probability.
The candle API assumes completed 5m bars supplied by the caller; it does not know
wall-clock freshness or validate upstream exchange close flags. Deployment must
enforce those data-source contracts. No historical economic dataset was replayed.
