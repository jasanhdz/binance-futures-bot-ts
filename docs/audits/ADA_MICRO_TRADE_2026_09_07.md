# ADA Micro Trade Audit, 2026-09-07

## Scope And Verdict

Production was read-only. Baseline HEAD was `69955236fd58871bd696ee947907ce97b3fd0e07`, with a clean worktree. PID 179797 was still running, started at 09:25:21 UTC. No restart, deployment, order mutation, journal/state repair, commit or push was performed.

The entry belongs to **MICRO_BURST_V1**, not Aegis or Momentum. A demonstrated concurrency defect allowed manual-position adoption to take ownership while Micro's market entry was awaiting confirmation. The manual flow then placed protection using its own ROE policy instead of Micro's structural policy. This audit fixes that adoption race locally. It does **not** establish the realized loss, the closing order, or a profitable strategy improvement.

## Evidence Index

- `data/runtime/entry-mutations-binance-futures-bot-primary-production.jsonl:1-3`: immutable entry request, UNKNOWN, then OPEN_CONFIRMED.
- `data/runtime/stop-mutations-binance-futures-bot-primary-production.jsonl:1-2`: later identified structural-stop request, PREPARED then UNKNOWN, with no confirmed order ID.
- `data/runtime/close-mutations-binance-futures-bot-primary-production.jsonl`: empty at audit time.
- `data/strategy-telemetry/events-v2.jsonl:40840,40860`: ADA execution intent and failed protection result.
- `logs/history-2026-09-07.log:1254-1267`: signal, manual adoption, protection failure, manual SL/TP submissions, and pending Micro supervision.
- `logs/aegis/turbo_trade_events_2026-09-07.jsonl:140-142`: bracket events under `MANUAL-ADAUSDT-1788779254580`; later events mix that manual ID with Micro strategy metadata.
- `logs/history-2026-09-07.log:2048`: position missing, accounting pending. There are 366 `micro_stop_supervision_unknown` events in this daily log.
- `logs/micro-burst/shadow-outcomes/2026-09-07-1788775865890.jsonl:11`: five-minute prospective signal outcome, not a live trade close.
- `data/state_PROD_AEGIS_STATE_JSON_ADAUSDT.json:1-66`: IDLE, Micro identity, ambiguous entry, unverified PnL, and mixed legacy metadata.

The exact signal was not found in the SQLite signal/outcome tables queried read-only, or by its signal ID in the active decision-blackbox file. The prospective JSONL is the available detailed outcome evidence. This is not a claim that all archives or all market ticks were recovered.

## Trade And Timeline

Trade ID: `MICRO-BURST-V1-ADAUSDT-20260907-110659-277`.

Signal ID: `shadow-MICRO_BURST_V1-ADAUSDT-SHORT-22-29812986`.

Version: `0.8.0-expected-continuation-live`. Config hash: `093ab31d5531272246e7d408c0351d3a41e7d3716deaa02bf25ba39a43db2f1b`.

| UTC          | Evidence                                                                    |
| ------------ | --------------------------------------------------------------------------- |
| 11:06:29.978 | Signal context snapshot timestamp.                                          |
| 11:06:48.415 | Signal observed; requestedAt retained in entry intent.                      |
| 11:06:59.277 | Execution intent recorded; trade ID generated.                              |
| 11:07:27.684 | Entry PREPARED: SHORT, 3295 ADA, 20x, fraction 0.9.                         |
| 11:07:34.299 | ENTRY_SEND_UNKNOWN. Exact cause is not persisted.                           |
| 11:07:34.580 | Runtime manual adoption observes SHORT 3295 at 0.2189.                      |
| 11:07:37.297 | Entry OPEN_CONFIRMED, order `67663831129`, average 0.2189.                  |
| 11:07:41.692 | BRACKETS_FAILED, stop 0.2201, positionStillOpen and protectionPending true. |
| 11:07:48.545 | Manual-flow algo SL acknowledged at 0.22328.                                |
| 11:07:54.853 | Manual-flow algo TP acknowledged at 0.20796.                                |
| 11:08:13.311 | Later Micro structural-stop mutation PREPARED at 0.2201.                    |
| 11:08:19.444 | That stop mutation becomes UNKNOWN.                                         |
| 12:51:41.719 | Local operational exit timestamp; missing-position log follows at .811.     |

The fill's exact exchange timestamp and individual fill IDs are unavailable in these records. OPEN_CONFIRMED is a local evidence timestamp, not the fill time. The entry had already become observable by manual adoption.

Snapshot-to-observation latency was 18.437 seconds; observation-to-PREPARED was 39.269 seconds; observation-to-OPEN_CONFIRMED was 48.882 seconds. These are pipeline intervals, not isolated network latencies. Reference and recorded average fill both equal 0.2189, hence observed aggregate entry slippage is zero at the recorded precision. This does not prove every fill had zero slippage.

## Why The Signal Entered

The signal chose SHORT near resistance 0.2197, targeting support 0.2162, invalidating at 0.2201394. Momentum strength was 1 and continuation score 0.954119. The observed taker-flow sample contained buy volume 402334, sell volume 833267, net -430933 across 261 samples. BTC was classified neutral/non-conflicting. The book and data quality were marked healthy.

The gross structural opportunity was 123.344 bps against 56.619 bps risk, reward/risk 2.17847. `MicroBurstEntryPolicy.ts` checks structural side, momentum alignment, continuation, BTC conflict and geometry. Its microregime is diagnostic, not a hard directional veto. Consequently SHORT during `TRENDING_UP` is permitted by this policy; it is not proof of an inverted comparison or a strategy implementation error. Confidence 1 is a score, not a calibrated 100% probability of profit.

The shadow record's 40x high-confirmation leverage is not the live exposure. The durable live intent and observed position both show 20x and the intent requests the approved 0.9 fraction. Legacy local values such as fraction 0.12, requested leverage 15, Aegis reasons and wallet snapshots must not override that evidence.

## Demonstrated Execution Defect

`PositionRecoveryService.tryAdoptManualPositionRuntime` originally checked IDLE once, awaited exchange reads, then unconditionally adopted the position and launched manual brackets. It did not consult the Micro entry reservation or the durable entry coordinator.

Micro leaves its prior local identity in place until execution returns. `TradingService` captures this identity for structural protection. The manual adoption at 11:07:34.580 changed that identity before the confirmation/protection handoff. `DurableStopCoordinator.supervise` correctly refuses a changed identity, so initial protection failed without a structural-stop journal entry at that stage. Micro's failure projection then restored bot ownership while the already-running manual bracket flow continued. The manual flow subsequently wrote its stop into local state. The observed interleaving and mixed-ID bracket events match this code path.

The later structural-stop send has UNKNOWN evidence only. The coordinator catches send/ACK errors without persisting their specific cause, and exact readback did not establish protection. A timeout, rejection, or invalid receipt cannot be distinguished here. Do not invent a Binance error code or authorize a resend from the empty order list.

The manual flow's explicit standard-endpoint rejection was -4120/unsupported order type, followed by successful Algo fallback. That logged rejection is **not** evidence for the later identified Micro stop's unknown outcome.

While supervision returned UNKNOWN, `TradingService.managePositionByOwner` returned before the intelligent Micro exit manager. Therefore this was not an ordinary execution of Micro's entry-and-exit policy. The empty durable close journal is consistent with that, but does not identify how Binance eventually became flat.

## Economics And Limits

| Quantity-derived metric                                           |       USDT |
| ----------------------------------------------------------------- | ---------: |
| Entry notional, 3295 \* 0.2189                                    | 721.275500 |
| Nominal initial margin at 20x, before fees/adjustments            |  36.063775 |
| Gross loss if filled exactly at structural invalidation 0.2201394 |   4.083823 |
| Gross loss if filled exactly at rounded structural stop 0.2201    |   3.954000 |
| Gross loss if filled exactly at manual stop 0.22328               |  14.432100 |
| Gross gain if filled exactly at original target 0.2162            |   8.896500 |

These are **scenario calculations, not realized PnL**. The manual stop distance is 3.534 times the structural distance. There is no verified closing price, closing quantity breakdown, gross realized PnL, commission amount/asset, funding allocation or net PnL. No account-balance delta was substituted for trade accounting. For a fully matched SHORT, gross PnL is sum(entry proceeds) minus sum(exit costs); net additionally includes verified commissions and attributable funding.

The five-minute signal-price outcome reports MFE 18.273 bps, MAE 4.568 bps, final gross return +4.568 bps and neither barrier touched. At a hypothetical total cost of 10 bps, that horizon's net is -5.432 bps. These excursions start at the signal snapshot, not at the real fill, and cover only five minutes, not the approximately 104-minute confirmed-entry-to-flat-observation interval.

The shadow dynamic-exit record says EARLY_FAILURE at 11:07:31.037 with zero gross return. It is not a live exit, and its zero net field is not evidence of zero real commissions. It predates local entry confirmation and cannot be claimed as an achievable live counterfactual without latency-aware replay.

The ten earlier Micro execution failures are SUI (6), DOGE (3), BNB (1). Their telemetry reasonDetail is `symbol_blocked_pending_market_open_reconciliation`, matching persisted ambiguity flags and the pre-send guard in Shared execution. They are ten denied attempts, not ten newly submitted ambiguous orders. The historical origin of those flags was not resolved or cleared.

## Applied Changes And Validation

- Required recovery admission callback wired to existing entry reservations and durable pending evidence, including startup recovery.
- Runtime adoption rechecks local ownership identity, IDLE state and quarantine after asynchronous exchange reads.
- Ambiguous entries and unverified Micro accounting cannot be reclassified as manual positions.
- Failed-entry warning now includes selected stage/pending metadata without dumping exchange errors or credentials.
- Nine new recovery unit cases and one TradingService integration case cover reservations, async races, bot ownership handoff, startup and absence of manual brackets during a Micro fill. Existing genuine-manual adoption still passes.
- Targeted validation: **46 files, 968 tests passed** across position recovery/protection, durable entry/stop/close/cancel, Micro and Binance brackets.
- TypeScript build passed using `npm run build -- --outDir /tmp/opencode/ada-audit-build`. The running deployment's `dist` was not overwritten.

No alpha thresholds, stop distances, sizing, leverage, safety latches or production configuration changed. The patch prevents a demonstrated policy-ownership violation; profitability has not been validated.

## Production Check And Remaining Work

The existing allowlisted read-only client completed three signed GET requests at 15:02:11.615-15:02:12.341 UTC: zero nonzero positions, zero regular open orders, zero algo open orders. Counters showed no mutations, no non-allowlisted endpoints, no redirects and no retries. This fresh observation does not settle historical PnL or the unknown stop.

The audited client allowlist has no user-trades, income, historical-orders or exact historical-algo query. This turn did not expand or bypass it. Closing attribution requires a separately reviewed read-only historical evidence path or a verified exchange export, matched to the entry ID and the exact protection IDs. Keep quarantine until the durable recovery/accounting protocol can accept that evidence; do not manually edit journals or clear flags.

Before any new deployment: review the patch, reproduce lost-ACK and ownership handoffs in a non-production environment, resolve the existing stop/accounting evidence, and approve the exact new revision through the existing deployment gate.

For signal improvement, pre-register and test trend alignment and signal-age revalidation as hypotheses, not tuned reactions to ADA. Use chronological out-of-sample episodes, deduplicate correlated signals, include fees/funding/slippage and observed pipeline latency, compare against unchanged policy across symbols/regimes, and require stable net expectancy and drawdown improvement. Missing market-data intervals must stay excluded/unknown. Neither a single loss nor the short prospective outcome supports a guarantee of profitable trades.
