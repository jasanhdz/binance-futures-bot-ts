# Micro offline input forensics and broader cohorts

Reviewed and verified on 2026-09-14. This supplements the [pattern experiment](micro-burst-offline-pattern-experiment.md), retaining its two patterns, CURRENT alignment, episode rules and thresholds.

## Conclusions and evidence levels

- **Recorded-input fact:** XRP and SUI have numerical revisions after both versions entered the prepared closed series. Raw adapter-output and prepared candle values agree within each observation. This is not JSON property-order normalization or a merely open-to-closed transition.
- **Recorded-input fact:** SOL line 59 and BNB line 273 stop at `CONTEXT_QUALITY` with `btc_event_stale`. Their BTC receive ages are below 60 seconds but candle-close event ages exceed 60 seconds, including at the exchange-clock lower bounds.
- **Source-verified and deterministically reproduced defect:** the BTC scheduler anchors an earlier exchange sample to a later poll completion, omitting intervening candle-read latency. This can delay boundary refresh. The historical input-source files match the reviewed source. Missing poll/request/cache provenance prevents assigning the precise observed delay to that defect alone.
- **Diagnostic only:** downstream inputs reveal additional concerns, but the unvisited guards did not pass. There is no bypass evaluation or hypothetical valid-entry verdict.
- **Broader replay evidence:** nine independently reset, chronologically ordered rotated-file cohorts contain 7,259 validated records. Each cohort has zero CURRENT entries and zero entries in either pattern union. This does not establish a continuous-run episode total, execution admission, profitability or an entry-frequency advantage.

## 1. XRP/SUI before and after

All decision line references in sections 1–3 refer to uncompressed, 1-based lines in `data/strategy-blackbox/strategy-decisions/decisions-v2.2026-09-13T20-03-08-058Z.44.jsonl.gz` (SHA-256 `85dc3b7aa8adb8a69aa28558048b2c87f04ad3b86a29c35ae8ae5da967ac4fec`; 42,694,526 compressed bytes). The fresh forensic run validates all 806 exact inputs with zero validation errors and zero malformed lines.

Both candles span **1789329180000–1789329239999**, i.e. **2026-09-13 19:53:00.000–19:53:59.999 UTC**. Epoch timestamps below are milliseconds; snapshot timestamps use exchange time and capture/read timestamps use local receive time.

| Symbol/version | Decision line | Snapshot exchange ms | Snapshot minus close ms | Local capture completed ms | Adapter read requested → received ms |
| -------------- | ------------: | -------------------: | ----------------------: | -------------------------: | ------------------------------------ |
| XRP before     |           326 |        1789329241117 |                    1118 |              1789329244711 | 1789329241215 → 1789329244044        |
| XRP after      |           336 |        1789329249820 |                    9821 |              1789329255856 | 1789329249945 → 1789329255543        |
| SUI before     |           324 |        1789329240098 |                      99 |              1789329243032 | 1789329240202 → 1789329242519        |
| SUI after      |           337 |        1789329251114 |                   11115 |              1789329257004 | 1789329251250 → 1789329256363        |

| Symbol  | Open / high / low        | Close before → after | Volume before → after | Buy volume before → after |
| ------- | ------------------------ | -------------------- | --------------------- | ------------------------- |
| XRPUSDT | 1.3534 / 1.3538 / 1.3534 | 1.3537 → 1.3538      | 52832.8 → 52927.1     | 35063 → 35073.2           |
| SUIUSDT | 0.7178 / 0.7182 / 0.7177 | 0.7181 → 0.7181      | 35801.8 → 36298.6     | 29313.2 → 29795           |

The revised XRP version persists for 43 observations through line 797; SUI for 44 through line 805. Each initial closed version occurs once. The earlier forming-candle versions are separately labeled `RAW_ONLY` in the forensic artifact. All four rows above are `IN_PREPARED_CLOSED_SERIES`, with raw/prepared numerical equality. The pattern runner excludes the two revision observations plus 85 subsequent quarantined-symbol evaluations.

### Exact provenance anchors

| Version    | Decision ID                                                        | Derived market snapshot ID             | Snapshot file line |
| ---------- | ------------------------------------------------------------------ | -------------------------------------- | -----------------: |
| XRP before | `61aaa3f7ebd3e708e17ee3798d60bb426642c6f24b5bd2419e0db91864293846` | `848d8271-4668-49c8-8bde-997a704055fd` |              89244 |
| XRP after  | `785971c43dcc80af8b332012b9ead88a554121533e4db403b22d096a0f2988c3` | `2c9022c1-e922-4110-89e3-2e80b0af9b42` |              89254 |
| SUI before | `abe0e803a265be8977a47f3c3fd9fd05ded73f0a57796dffbce1243f4bb4b80b` | `3d476238-5b65-4112-b838-a17d8c5a81f0` |              89242 |
| SUI after  | `7fdbc75e64a419067fe8d55c4a6f4c89c5ec8c977bdd6d939e9637c43ba4f93f` | `5970a263-75b2-4119-b042-d5401d6a367f` |              89255 |

Numerical SHA-256 hashes, over the ordered open/close times and OHLCV/buy-volume fields:

```text
XRP before 94f125c5492380e732773b687186eb858ad621437356984a7f57090ee2b9cd1c
XRP after  9efe019009c2cfee9bc5204b5fd64e9b009effd1924f0dca1591e031f09db4e1
SUI before 7e5c53e2e7ada329933e6f2f55654e9869a70dce68f0ac95a4263e47231c01ed
SUI after  04fc98e1f731a0e6057879c2676289be464c1df30967fae48a8a64c26eb58323
```

The forensic JSON additionally preserves full candle objects, JSON and canonical hashes, decision content hashes, clock bounds and read-duration measurements. All **16 requested snapshot IDs match 16 records**, with **0 recomputed content-hash mismatches**, **0 decision-reference hash mismatches**, and **0 unmatched IDs**. The relevant `market-snapshots/snapshots-v2.jsonl` read was unchanged during the complete scan: 93,353 lines, 267,280,384 bytes, SHA-256 `b4ab7f00b2f9bb67b177dcf276a3a49b532d043a9e4c3c7999183cc065c05147`. This unrotated snapshot file is evidence of a stable read, not an immutable rotated source.

**Important provenance boundary:** these snapshots say `POST_EVALUATION_FROM_EXACT_INPUTS`; their candle component is `NOT_REQUESTED`. They corroborate decision linkage and derived features, not independent exchange candle values. The candle evidence comes from the exact replay's saved `inputSources.rawCandles` and prepared series.

### Normalization, closed classification and unresolved origin

`BinanceAdapter.fromRestCandle` maps REST fields to numbers and aliases `timestamp` to `openTime`; `getCandles` may return its REST-derived candle cache. `prepareClosedCandles` validates the sequence and removes at most one forming tail using `closeTime > snapshotAtMs`; equality is closed. It does not rewrite OHLCV. All four snapshots are strictly later than the inclusive close time, and their saved raw and prepared values agree. Therefore these are genuine revisions of **inputs classified as closed by the application**, already present upstream of preparation.

Original REST response strings, exchange publication/finalization flags, original cache fetch time, cache-hit identity, and adapter enqueue/dequeue times were not saved. A cached forming observation subsequently classified by wall-clock time, delayed publication, or an upstream correction cannot be distinguished from this record alone. The evidence does **not** prove Binance revised a previously finalized exchange candle, nor justify silently replacing the earlier evidence.

## 2. SOL/BNB BTC clocks and refresh defect

BTC `observedAtMs` means the latest closed BTC 1m candle's **close time**. `receivedAtMs` is the local time at which `BtcMicroContextProvider.pollCandles` completes the series read; it is not an exchange packet timestamp. The builder's `btcAgeMs` and `btcStatus` use receive age, while its separate event check uses `snapshotAtMs - observedAtMs`. The reaction policy would also check event freshness at the conservative exchange evaluation upper bound, if reached.

| Saved/reconstructed quantity (ms)         |        SOL line 59 |       BNB line 273 |
| ----------------------------------------- | -----------------: | -----------------: |
| BTC candle event time                     |      1789328879999 |      1789329119999 |
| BTC provider receive time                 |      1789328895233 |      1789329133461 |
| Snapshot exchange time                    |      1789328944139 |      1789329183839 |
| Local evaluation time                     | 1789328947411.3008 |  1789329188827.323 |
| Exchange evaluation upper bound           | 1789328955319.1443 | 1789329192381.6575 |
| Server-request RTT                        |  8006.643809996545 |  3647.446520000696 |
| Event age at snapshot                     |              64140 |              63840 |
| Event age at builder exchange lower bound |  67313.19970703125 |  68734.88793945312 |
| Event age at evaluation lower bound       |  67313.50048828125 |      68735.2109375 |
| Event age at evaluation upper bound       |  75320.14428710938 |  72382.65747070312 |
| Provider receive age at evaluation        |     52178.30078125 | 55366.322998046875 |
| Recorded builder `btcAgeMs`               |              52175 |              55362 |
| Configured BTC freshness maximum          |              60000 |              60000 |

The BTC candle event times are respectively **19:47:59.999 UTC** and **19:51:59.999 UTC** on September 13. Both records have `btcStatus: HEALTHY`, `contextValid: false`, and only `btc_event_stale` in `invalidReasons`. The small builder/evaluation receive-age difference reflects different observation instants. The discrepancy is explained by the two age definitions, not by treating exchange and local clocks as interchangeable. Staleness remains even at the lower exchange bound, so it is not merely an upper-bound/RTT artifact.

The next observed BTC updates are:

- At line **66**, event **1789328939999**, provider receive **1789328952860**; first saved local evaluation seeing it **1789328953642.2893**.
- At line **280**, event **1789329179999**, provider receive **1789329196438**; first saved local evaluation seeing it **1789329197006.6113**.

These are observations of newer provider state, not proof of the first exchange publication or exact poll-start time. The full file has 16 distinct BTC state transitions when candidate-specific `conflictFlag` is excluded from the update fingerprint.

### Source defect: omitted elapsed read time

`MarketDataCandleProvider.getSeries` samples server time **before** awaiting candles. `BtcMicroContextProvider` pairs that earlier `exchangeSnapshotTimeMs` with **poll-completion** local time in `exchangeClock`. The subsequent boundary calculation advances only from that later completion. Thus candle-read latency is omitted from estimated exchange time and can be added to the next refresh delay.

The deterministic test uses synchronized clocks, a poll starting at minute boundary +30,000 ms and a 6,000 ms candle read. The next poll starts at **boundary +66,250 ms**, rather than boundary +60,250 ms, and the new event is received at **boundary +72,250 ms**. The old event is already over 60 seconds old before that refresh. This reproduces a source-level timing defect without changing the provider.

Historical commit `c004b37054fd334e3053301f17143a2faeea492b` and the worktree have identical hashes for `BinanceAdapter.ts`, `CandleIntegrity.ts`, `MarketDataCandleProvider.ts`, `BtcMicroContextProvider.ts`, `MicroBurstContextBuilder.ts`, and `MicroBurstBlackBoxObservation.ts`. The wider comparison finds diagnostic-only changes in `MicroBurstEvaluator.ts` and `MicroBurstRuntime.ts`; it is not a whole-runtime identity claim.

The exact BTC poll request, server-sample pairing, packet receipt, queue delay and cache origin are absent from replay. Consequently, the test proves the mechanism exists in the historical source; it does not reconstruct how much of either recorded late refresh came from scheduling versus REST/cache/publication latency. No freshness threshold was relaxed.

## 3. Unvisited guards: diagnostic facts only

Both recorded evaluations visited exactly **CONFIG → CONTEXT_QUALITY**. `BOOK_HEALTH`, the reaction-level BTC/event check, snapshot/book/spread/flow/candle checks, level selection/availability, defense proximity, direction/flow, trigger, degradation, BTC conflict, structural geometry, gross room/RR, leverage and net cost/RR were **not reached**, not passed. The pattern evaluation preserves the same context rejection.

| Saved predicate                                       | SOL LONG                          | BNB SHORT                         |
| ----------------------------------------------------- | --------------------------------- | --------------------------------- |
| Momentum direction                                    | NEUTRAL, does not match LONG      | SHORT, matches                    |
| Net taker flow                                        | -4801.429999999926, wrong sign    | -163.6899999999996, matching sign |
| Executable quote                                      | ask 100.87                        | bid 721.2                         |
| Reference opposing level                              | resistance 101.31, ahead of quote | support 721.22, above SHORT quote |
| Available opposing level ahead of quote in saved pool | 101.31                            | none                              |
| Local execution-book age (ms)                         | 93.30078125                       | 38.322998046875                   |
| Exchange-upper snapshot age (ms)                      | 11180.144287109375                | 8542.657470703125                 |
| Exchange-upper flow event age (ms)                    | 8239.144287109375                 | 5283.657470703125                 |

These ages are below the saved 30,000 ms book/snapshot/flow threshold, but are not complete guard verdicts. SOL's saved direction/flow contradict CURRENT LONG alignment. BNB's matching direction/flow does not establish usable target geometry: its reference support is already behind the executable SHORT entry and the saved available opposing pool has no level below that quote. Room minimum **30 bps**, gross reward/risk minimum **1.5**, near-level threshold **50 bps**, and estimated round-trip cost **14 bps** remain unchanged. No stop, leverage, net RR or account-admission success is inferred from these descriptive facts.

## 4. Broader stable evidence: nine separate cohorts

Artifact: `/tmp/opencode/micro-pattern-cohorts.json`. All nine compressed source hashes, the reaction-source hash and all three pattern-tooling source hashes were rechecked against the current files. Each report records baseline verification and the same full config SHA-256 for all 11 symbols:

`6e7812f45bd2b73e078e69d00acf69f669dcd9cd64795e1741a4b13a8d946653`

The same two episode rules, three-candle confirmation window, frozen 15 bps tolerance, CURRENT alignment and downstream policy are used throughout. The cohort CLI rejects duplicate source hashes, unverified baselines and differing config hashes. The reviewed artifacts also have identical policy/tooling hashes.

**State boundaries are explicit:** every file starts a new tracker with its own supplied historical warm-up and quarantine. The files are temporally ordered, but per-symbol candle continuity, restart state and quarantine are not carried across files. Historical warm-up overlaps, so episode starts, confirmations and evaluation attempts must not be added as independent continuous-run opportunities. For example, the same BTC SHORT defense episode (`resistance 77362.16666666667`, initiation **1789327800000**, confirmation **1789327919999**) is evaluated in cohort 42 line 782 and again after reset in cohort 43 line 10. DOGE's defense confirmation **1789332779999** likewise appears in cohort 47 line 797 and cohort 48 line 7.

The observation span is **2026-09-13 18:46:54.048–21:09:53.901 UTC** in exchange snapshot time. Exact per-cohort exchange bounds and results follow. `M` is MULTI_CANDLE_RECLAIM and `Z` is CONFIRMED_ZONE_DEFENSE; confirmed counts include warm-up, and `eval` means post-confirmation attempts, not entries.

| Cohort | Exchange snapshot min → max (ms) | Validated | Processed / excluded | Revisions / later quarantine | M starts / confirmed / eval | Z starts / confirmed / eval | Entries CURRENT / +M / +Z |
| ------ | -------------------------------- | --------: | -------------------- | ---------------------------- | --------------------------- | --------------------------- | ------------------------- |
| 40     | 1789325214048 → 1789326132978    |       806 | 801 / 5              | 1 / 4                        | 10 / 3 / 1                  | 58 / 42 / 3                 | 0 / 0 / 0                 |
| 41     | 1789326133240 → 1789327046628    |       806 | 715 / 91             | 3 / 88                       | 10 / 3 / 0                  | 35 / 25 / 3                 | 0 / 0 / 0                 |
| 42     | 1789327046932 → 1789327957990    |       807 | 807 / 0              | 0 / 0                        | 10 / 4 / 2                  | 20 / 10 / 1                 | 0 / 0 / 0                 |
| 43     | 1789327958257 → 1789328873078    |       806 | 719 / 87             | 3 / 84                       | 11 / 4 / 0                  | 24 / 12 / 2                 | 0 / 0 / 0                 |
| 44     | 1789328873328 → 1789329782202    |       806 | 719 / 87             | 2 / 85                       | 10 / 3 / 1                  | 21 / 8 / 1                  | 0 / 0 / 0                 |
| 45     | 1789329782449 → 1789330788749    |       805 | 701 / 104            | 2 / 102                      | 4 / 3 / 0                   | 25 / 14 / 8                 | 0 / 0 / 0                 |
| 46     | 1789330789887 → 1789331742912    |       806 | 806 / 0              | 0 / 0                        | 5 / 3 / 1                   | 31 / 16 / 5                 | 0 / 0 / 0                 |
| 47     | 1789331744187 → 1789332800150    |       809 | 809 / 0              | 0 / 0                        | 4 / 2 / 0                   | 29 / 15 / 3                 | 0 / 0 / 0                 |
| 48     | 1789332800401 → 1789333793901    |       808 | 641 / 167            | 4 / 163                      | 3 / 0 / 0                   | 24 / 12 / 3                 | 0 / 0 / 0                 |

Every cohort has zero malformed records, missing replay, incompatible inputs, historical mismatches and source mismatches. Within each file there are zero duplicate decision IDs and zero duplicate exact inputs. Historical and CURRENT source parity cover **7,259/7,259 records** across the distinct files; this sum is a record-coverage count, not an episode count. Envelope nonfinite-confidence serialization losses per cohort are respectively **14, 9, 19, 17, 15, 15, 15, 17, 8** and are explicitly accounted for.

| Cohort | Actual rejection reasons for pattern attempts                                                       |
| ------ | --------------------------------------------------------------------------------------------------- |
| 40     | Z: BTC_UNAVAILABLE 1, CONTEXT_INVALID 1, LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER 1; M: CONTEXT_INVALID 1 |
| 41     | Z: CONTEXT_INVALID 2, LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER 1                                          |
| 42     | M: CONTEXT_INVALID 2; Z: LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER 1                                       |
| 43     | Z: CONTEXT_INVALID 1, LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER 1                                          |
| 44     | M: CONTEXT_INVALID 1; Z: CONTEXT_INVALID 1                                                          |
| 45     | Z: CONTEXT_INVALID 6, DIRECTION_NOT_CONFIRMED 2                                                     |
| 46     | Z: CONTEXT_INVALID 3, DIRECTION_NOT_CONFIRMED 2; M: DIRECTION_NOT_CONFIRMED 1                       |
| 47     | Z: CONTEXT_INVALID 3                                                                                |
| 48     | Z: CONTEXT_INVALID 2, LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER 1                                          |

Except `BTC_UNAVAILABLE`, reason names in this compact table have the `REACTION_` prefix. The table reports actual first rejections; it does not equate every broader `CONTEXT_INVALID` with the specifically investigated BTC defect. Cohorts 42, 46 and 47 have complete pattern-input coverage yet still no accepted additions. The saved JSON contains full evaluation ledgers, episode status counts, repeated-candle accounting, overlap records and bounded examples. This is descriptive evidence from this period, with selection and reset limitations, not a statistical power or general-market claim.

### Rotated source manifest

All files are under `data/strategy-blackbox/strategy-decisions/`:

```text
decisions-v2.2026-09-13T19-02-17-598Z.40.jsonl.gz f671befccbb344931084fd0c988add3cc7b400f2891d65f7da86c3080ed73e18
decisions-v2.2026-09-13T19-17-32-727Z.41.jsonl.gz 25f279722c03db03acc57b1317c286ce94d014ae166e590aee4594a2f73baf5d
decisions-v2.2026-09-13T19-32-44-873Z.42.jsonl.gz a4cd9a8d9ec6d4e831978faaa65da4dfd4b4527d1d3f46a6193464ce064521df
decisions-v2.2026-09-13T19-47-59-386Z.43.jsonl.gz d2fcf0b8cfef50d3d5648d60067011fca715bf9341809928915af57b00d51a62
decisions-v2.2026-09-13T20-03-08-058Z.44.jsonl.gz 85dc3b7aa8adb8a69aa28558048b2c87f04ad3b86a29c35ae8ae5da967ac4fec
decisions-v2.2026-09-13T20-19-55-699Z.45.jsonl.gz 2e21e578990765d6039cc771402d2070efc7acf4f5afecec4e1484256ade85ab
decisions-v2.2026-09-13T20-35-50-492Z.46.jsonl.gz a42a0f010ec764199f3534bff9e087e382dd652201b38818796a65739d8c719e
decisions-v2.2026-09-13T20-53-27-229Z.47.jsonl.gz 9c1182ce248b86c2b577ce1cf0d19af8afc3139eea7cf2663f8352d0e181e220
decisions-v2.2026-09-13T21-10-02-413Z.48.jsonl.gz 002fca781c1bab4160eaadcdf959c1b4a59dd4b0f79aeface7bb2ccd8a83dfc4
```

## Reproduction and completed verification

```bash
npm run build
node dist/tooling/micro-burst/MicroBurstInputForensics.js data/strategy-blackbox/strategy-decisions/decisions-v2.2026-09-13T20-03-08-058Z.44.jsonl.gz data/strategy-blackbox/market-snapshots > /tmp/opencode/micro-input-forensics-verified.json
node -r ts-node/register src/tooling/micro-burst/MicroBurstPatternCohorts.ts data/strategy-blackbox/strategy-decisions/decisions-v2.2026-09-13T*.4[0-8].jsonl.gz > /tmp/opencode/micro-pattern-cohorts-reproduced.json
npx vitest run src/tooling/micro-burst/MicroBurstInputForensics.test.ts src/tooling/micro-burst/MicroBurstPatterns.test.ts src/strategies/micro-burst/domain/MicroBurstTemporalContracts.test.ts src/tooling/micro-burst/MicroBurstExactReplayCli.test.ts src/strategies/micro-burst/domain/MicroBurstReactionEntryPolicy.test.ts
git diff --check
```

Completed in this continuation:

- **103 tests passed in 5 files:** forensics/cohorts 8, patterns 39, temporal contracts 23, exact replay CLI 1, reaction policy 32.
- **TypeScript build passed.**
- Fresh full forensic replay and hashed snapshot scans completed; results above come from `/tmp/opencode/micro-input-forensics-verified.json`. The original artifact is preserved.
- The existing nine-cohort artifact was selectively reviewed and all nine source hashes plus policy/tooling hashes revalidated; its nine comparisons were not rerun in this continuation. The reproduction command above is provided for that purpose.
- Targeted Prettier checks and `git diff --check` passed.

All work was offline. Existing strategy/alignment edits were preserved; this continuation adds the reviewed report and corrects the earlier documentation's dependency-identity scope. No LIVE configuration change, deployment, commit or production trigger expansion was performed. Temporary artifacts are local evidence, not durable repository attachments; the source manifest, exact findings and reproduction commands are retained here.
