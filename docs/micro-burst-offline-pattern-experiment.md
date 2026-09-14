# Micro offline closed-candle pattern experiment

## Implementation and reproduction

Run from the repository root:

```bash
npm run build
node dist/tooling/micro-burst/MicroBurstPatternComparison.js data/strategy-blackbox/strategy-decisions/decisions-v2.2026-09-13T20-03-08-058Z.44.jsonl.gz > /tmp/opencode/micro-pattern-comparison.json
```

The equivalent source entry point is `npx ts-node src/tooling/micro-burst/MicroBurstPatternComparison.ts SAMPLE`.
The CLI reads one stable, rotated gzip, verifies its inode/size/mtime and compressed SHA-256 again after processing, and outputs JSON. It does not load environment configuration or start trading services.

- `src/tooling/micro-burst/MicroBurstPatternEpisodes.ts`: causal, stateful episode tracker.
- `src/tooling/micro-burst/MicroBurstPatternEvaluator.ts`: offline instrumentation of the local CURRENT reaction source.
- `src/tooling/micro-burst/MicroBurstPatternComparison.ts`: exact replay validation, historical compatibility checks, comparison CLI and evidence ledgers.
- `src/tooling/micro-burst/MicroBurstPatterns.test.ts`: mirrored sequences and downstream/replay integration tests.

The pre-existing reaction alignment changes and `scripts/micro-burst-compare-alignment.ts` were inspected and preserved. This experiment always calls alignment policy `CURRENT`; it does not use the alignment comparison script.

## Episode contract

The initiating candle is candle **0**. Only closed candles **1, 2, 3** can confirm. An unconfirmed episode expires at close3, including when that close is missing from a later observation. Within the window, an adverse-edge close invalidates before recovery, confirmation or deadline expiry. A candle arriving after the deadline cannot retroactively confirm or invalidate an already expired episode.

- **MULTI_CANDLE_RECLAIM:** candle0 penetrates the center; a later candle closes favorable of center; a distinct later candle closes strictly more favorably than that recovery and remains favorable of center. “Holding” is a close-based condition; the confirmation wick may cross the center.
- **CONFIRMED_ZONE_DEFENSE:** candle0 intersects the tolerance zone; a later candle closes strictly beyond the favorable edge. Candle0 cannot itself confirm even if it closes beyond that edge.
- LONG uses native support; SHORT uses native resistance. CURRENT retains its own role-reversal entries in the union.
- Price, type, `availableAtMs`, temporal version `asOfMs`, and tolerance are frozen at initiation. The exact latest version available at candle0 open is selected; missing temporal history has no current-level fallback. Evidence cannot precede level availability or version availability.
- A stable ID contains symbol, side, pattern, level type/price/availability/version, and initiation open time. One episode is active per symbol/side/pattern; the nearest touching eligible level is selected at initiation.
- After termination, a **subsequent** favorable outside-zone close must occur before a **later** touch can restart. The terminal candle does not arm restart. Inside-zone candles and level-version updates do not renew opportunities.
- Missing candle continuity cannot confirm. Conflicting previously observed closed candles are reported with both versions; the runner quarantines that symbol for the rest of the sample.
- Full episode ledgers contain start/confirmation/invalidation/expiry timestamps, reasons and observation timestamps. Recovery time and price are recorded separately. Confirmation evaluation is attempted once, on the first observation whose latest closed candle is that confirmation; downstream rejection consumes that attempt.

## Integration boundary

The tooling compiler replaces only defended-level selection, frozen tolerance, causal visit-history lower bound, trigger recognition and setup labeling. It checks each source anchor occurs exactly once and fails on source drift. The CURRENT common guards, momentum/flow alignment, defense proximity/degradation, BTC conflict, structural geometry, leverage/confirmation checks and gross/net cost/risk calculations execute from the existing policy source.

Execution price is the actual recorded post-confirmation ask for LONG or bid for SHORT. Historical confirmation closes are never substituted for executable quotes. Target selection remains the CURRENT closest available opposing obstacle at evaluation.

This is **entry-intent replay**, not execution admission. The exact entry input does not supply approved account sizing, liquidation geometry, portfolio exposure, live duplicate routing or execution admission results. Those checks are not bypassed in production, but these entry counts do not establish that they would pass. Integrating these patterns into an executable proposal would require the existing approved-risk/admission pipeline. The offline source instrumentation is not a production extension point.

Any future outcome analysis must use the actual Micro intelligent exit plus an independent protective stop. Structural target geometry here does not impose a mandatory fixed take-profit. This experiment computes no PnL.

## Stable sample result

Source: `decisions-v2.2026-09-13T20-03-08-058Z.44.jsonl.gz`.

```text
Compressed SHA-256: 85dc3b7aa8adb8a69aa28558048b2c87f04ad3b86a29c35ae8ae5da967ac4fec
Compressed bytes: 42694526
Uncompressed bytes: 268290037
Recorded commit: c004b37054fd334e3053301f17143a2faeea492b
Checked-out commit: 22f1fd5d042bbefb07fb05f9952baf9d50af6180
Historical reaction SHA-256: 88d64a4932f4d6fba63ec62c6d729c0ca60d065346f01d95b140c1cd4919118e
Worktree reaction SHA-256: 1e9a3dc9722d0362fb5b8443ff806321e2a4a930d6ae839fe37b45311888abbf
```

The JSON also records all three tooling source hashes and the full historical-to-worktree reaction `git diff`. The enumerated entry/replay dependency diff against the recorded commit is empty; this is not a claim that the entire runtime is identical. The broader forensic source check finds diagnostic-only differences in `MicroBurstEvaluator.ts` and `MicroBurstRuntime.ts`. The reaction diff consists of the existing alignment experiments and added trigger diagnostics. Historical reaction execution and CURRENT execution agree on **806/806** exact inputs, excluding only the explicitly identified new `triggerInputs` diagnostic field from source-parity comparison.

All **806** lines parsed and passed existing exact replay validation. Recorded historical decisions agree on **806/806** records: **0** remaining historical mismatches, **0** source mismatches, **0** incompatible inputs, **0** missing replays, **0** duplicate IDs or exact inputs. Fifteen nonfinite confidence values become `null` in ordinary BlackBox envelope JSON; this known serialization loss is counted explicitly rather than treated as a strategy mismatch or filled with an invented value.

There are **172 unique symbol/closed-candle observations**, with **634 evaluations beyond the first per candle**. Pattern tracking processed **719** evaluations; **87** were excluded (2 closed-candle revisions and 85 subsequent quarantined-symbol evaluations). CURRENT still covers all 806 validated inputs. Consequently, the union results below describe observed eligible additions, not complete pattern coverage of excluded observations.

| Variant                          | Entry opportunities | Additional vs CURRENT | Independent new-pattern entry episodes |
| -------------------------------- | ------------------: | --------------------: | -------------------------------------: |
| CURRENT                          |                   0 |                     — |                                      — |
| CURRENT + MULTI_CANDLE_RECLAIM   |                   0 |                     0 |                                      0 |
| CURRENT + CONFIRMED_ZONE_DEFENSE |                   0 |                     0 |                                      0 |

An entry opportunity is a unique symbol/side/closed-candle key, not a repeated decision or fill. CURRENT also has zero independent accepted episode IDs.

| Pattern                | Independent starts | Confirmed including warm-up | Expired | Invalidated | Post-confirmation evaluations | Accepted |
| ---------------------- | -----------------: | --------------------------: | ------: | ----------: | ----------------------------: | -------: |
| MULTI_CANDLE_RECLAIM   |                 10 |                           3 |       7 |           0 |                             1 |        0 |
| CONFIRMED_ZONE_DEFENSE |                 21 |                           8 |      13 |           0 |                             1 |        0 |

Nine confirmations occurred in historical warm-up and were not evaluated retroactively. Both actual confirmation evaluations were blocked by `REACTION_CONTEXT_INVALID`, specifically `btc_event_stale`. CURRENT reasons were 126 `BTC_UNAVAILABLE`, 158 `REACTION_CONTEXT_INVALID`, and 522 `REACTION_NO_QUALIFIED_SIDE`.

Entry overlaps with CURRENT and between new patterns are all **0**. There are **5** same-symbol/side episode-interval overlap pairs between the new patterns, but **0** exact same-initiation/version episode pairs. The JSON lists those pairs explicitly; interval overlap is not counted as an extra entry.

### Concrete examples

Use the uncompressed **1-based line number** and decision ID to reproduce each example from the hashed source. The output contains full episode IDs, candle evidence, executable top-of-book and evaluation diagnostics.

1. **Line 59, SOLUSDT LONG, MULTI_CANDLE_RECLAIM**
   - Decision ID: `8364087ceb1fcc3fd0749078971c1d86f505f20331abb6ca41928f74d1ea02a6`.
   - Frozen support **100.83**, availability/version **1789327799999**, tolerance **0.15124500000000002**.
   - Candle0 opens **1789328700000**, low **100.79**, close **100.82**.
   - Recovery close **100.85** at **1789328879999**; candle3 confirms at **1789328939999**, close **100.86**.
   - Post-confirmation executable ask **100.87**, local evaluation **1789328947411.3008**, exchange evaluation **1789328955319.1443**.
   - Rejected for `btc_event_stale`; the historical close is not the entry price.
2. **Line 273, BNBUSDT SHORT, CONFIRMED_ZONE_DEFENSE**
   - Decision ID: `511a8a7f2f6eb2a3836fb256a863baee1773737f4d6aad4074b8a768d4ca8be4`.
   - Frozen resistance **722.4**, availability **1789325399999**, version **1789328399999**, tolerance **1.0836**; favorable edge **721.3164**.
   - Candle0 opens **1789329060000**, high **721.35** touches the zone. The subsequent close **721.21** at **1789329179999** confirms beyond the favorable edge.
   - Executable bid **721.2**, local evaluation **1789329188827.323**, exchange evaluation **1789329192381.6575**.
   - Rejected for `btc_event_stale`.
3. **Lines 336 and 337: conflicting closed-candle evidence**
   - XRPUSDT candle close time **1789329239999** changed close **1.3537 → 1.3538**, volume **52832.8 → 52927.1**.
   - SUIUSDT at the same close time changed volume **35801.8 → 36298.6**.
   - Both symbols were quarantined rather than silently accepting revised evidence.

## Verification and remaining research limits

```bash
npx vitest run src/tooling/micro-burst/MicroBurstPatterns.test.ts src/strategies/micro-burst/domain/MicroBurstTemporalContracts.test.ts src/tooling/micro-burst/MicroBurstExactReplayCli.test.ts src/strategies/micro-burst/domain/MicroBurstReactionEntryPolicy.test.ts
npm run build
npx prettier --check src/tooling/micro-burst/MicroBurstPatternEpisodes.ts src/tooling/micro-burst/MicroBurstPatternEvaluator.ts src/tooling/micro-burst/MicroBurstPatternComparison.ts src/tooling/micro-burst/MicroBurstPatterns.test.ts docs/micro-burst-offline-pattern-experiment.md
git diff --check
```

Tests exercise mirrored LONG/SHORT sequences, exact edges, distinct recovery/confirmation candles, close3 deadlines, invalidation precedence, continuity, missing-close expiry/backfill, lookahead, restart, frozen versions/tolerance, revised candles, executable quotes, CURRENT alignment, downstream blocks, source drift and exact replay rejection.

The sample demonstrates functioning detection and preserved downstream rejection, not an entry-frequency advantage. Initial episode state before the supplied causal history is unknown; warm-up counts are sample-reconstructed episodes. The [verified input-forensics and nine-cohort follow-up](micro-burst-offline-input-forensics.md) investigates the revisions, BTC timing and unreached guards and broadens the evidence using explicitly separate cohorts. Source instrumentation remains coupled to the local policy anchors. Account admission and outcome/PnL research remain separate future work.
