# MICRO_BURST_V1 M3.1 - Prospective Correctness And Archive

## Status

`MICRO_BURST_V1_M3_1_BLOCKED`

M3.1 corrects the production wiring and captures durable raw market data, but an official cohort must not begin until deployment supplies a committed SHA and the analyzer can recompute its mandatory controls from archived trajectories.

## Confirmed M3 Defects

- `TradingService` did not construct or inject an outcome tracker or outcome journal.
- The tracker retained a per-signal count-bounded trade buffer and could lose early 300s trajectory data.
- Completion recomputed horizons from mutable history.
- Recovery metadata was not restored; its “pending” journal reader actually returned completed IDs.
- The dynamic simulator claimed context-dependent exits while receiving no historical book/BTC context.
- Strategy version and provenance were inconsistent (`0.4.0` identity vs `0.3.0` evaluator, `UNCOMMITTED`, `default`).
- Trade callback timestamps used local receipt time instead of exchange time.
- The analyzer controls reordered/inverted existing output rather than recomputing perturbed signals.
- The book implementation consumed partial-depth and treated update IDs as sequential rather than applying USD-M `U/u/pu` continuity.

## M3.1 Corrections

- `TradingService` composes `MicroBurstOutcomeJournal`, `MicroBurstOutcomeTracker`, optional `MicroBurstStorage`, and `MicroBurstRuntime` in SHADOW only.
- Trade history is symbol-centric, event-time ordered, time-retained for at least ten minutes, and shared by simultaneous pending signals.
- Raw public trades and raw USD-M depth diffs are archived as hourly gzip NDJSON segments (`schemaVersion: 1`); `eventTime` and `receivedAtMs` remain separate.
- SQLite WAL metadata lives at `data/micro-burst/micro_burst_research.sqlite` by default. It records segments, checkpoints, features, signals, outcomes, pending state, cohorts, and gaps.
- USD-M book bootstrap discards stale diffs, bridges snapshot using `U <= snapshot + 1 <= u`, then enforces `pu === previous u`. Desync requires a new REST snapshot.
- M3.1 uses `0.4.1-prospective-correctness`, deterministic effective-config SHA-256, deployment SHA environment (`GIT_COMMIT_SHA`, `GITHUB_SHA`, or `COMMIT_SHA`), and a cohort ID.
- Horizon results are frozen when mature. Entry outcomes are calculated separately for `SIGNAL_PRICE`, `NEXT_TRADE`, and `CONSERVATIVE_SLIPPAGE` (exactly 5 bps).
- Price-only dynamic exits correctly simulate structural stop, target, early failure, break-even stop touch, trailing, and max hold. BTC/anomaly/momentum exits are explicitly not attributed without historical context replay.

## Archive And Retention

- Raw trades: `data/micro-burst/market-data/trades/<symbol>/<utc-hour>.ndjson.gz`
- Raw depth: `data/micro-burst/market-data/depth/<symbol>/<utc-hour>.ndjson.gz`
- Checkpoints/features: SQLite, intended at configurable 60s checkpoints.
- Recommended policy: raw depth 7-30 hot days; raw trades at least 30 days when disk permits; SQLite signals/outcomes/features retained until explicit archival.
- Gaps are persisted. A recovered signal without the necessary interval is marked `INCOMPLETE_DATA_GAP`, never zero-return.

## Cohort Gate

`MICRO_BURST_PROSPECTIVE_COHORT_READY` is logged only with a known committed SHA and healthy configured archive. Otherwise `MICRO_BURST_PROSPECTIVE_COHORT_NOT_READY` is logged. Old M3 records are not an M3.1 cohort.

## Remaining Blockers

- The analyzer deliberately reports RANDOM_SIDE and TIME_SHIFT unavailable when it is given only signal/outcome JSONL. It must be extended to replay archived market trajectories before those controls can be reported as evidence.
- Book/BTC/momentum context replay is not implemented, so dynamic exit reporting remains explicitly price-only.
- A committed deployment SHA must be supplied for an official cohort.

## Safety

`MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED` remains `false`. No MicroBurst code calls shared execution or any exchange mutation method.
