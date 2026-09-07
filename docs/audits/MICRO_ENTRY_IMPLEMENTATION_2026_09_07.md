# Micro Entry Safety And Reaction Candidate

## Authorization And Scope

The owner requested implementing the recommended Micro improvements, committing and
deploying `01-Trading-Bot` in PM2. This supersedes the earlier audit-only restriction
in the two September 7 audit documents. Their historical observations are preserved.
The previous standing authorization also permits a normal push on the current branch.

No Momentum economics, sizing, leverage, loss limits, Aegis enablement, exit policy,
manual brackets, historical journal evidence or quarantine flags are changed.

## Active Safety Changes

- Preserve the incoming ownership fixes and regression tests: pending bot fills cannot
  be adopted as manual; incomplete startup identity remains unresolved; verified
  ownership is independent of metrics eligibility; genuine external adoption remains.
- Carry the original signal snapshot timestamp into the durable intent. Missing,
  future or expired timestamps deny a new send, not permission to recreate an old intent.
- Reuse existing freshness budgets: snapshot age at most `candleFreshness1mMaxMs`
  (120 seconds), request age at most `bookFreshnessMaxMs` (30 seconds), and synchronized
  book age at most that same book budget. These are conservative validity ceilings,
  not a latency-calibrated alpha TTL. A request observed late does not reset snapshot age.
- Before PREPARED and immediately after its persistence, check healthy uncrossed
  executable spread, full visible depth for the final sized quantity, entry VWAP,
  liquidation-side invalidation, unchanged original stop/destination geometry,
  proximity to the original defended level and existing gross room/RR requirements.
- Apply the final check to the non-durable execution path too. Momentum retains its
  existing admission predicate; it does not receive Micro market/economic rules.
- A known no-send identity veto is `DENIED/SHARED_SAFETY_DENIED`, not a claimed
  ambiguous fill. Detailed `MICRO_*` reasons are recorded in admission diagnostics.
  If expiry happens after PREPARED, the existing durable RECOVERY_REQUIRED reservation
  remains blocked. No terminal evidence is invented to release it. UNKNOWN is never resent.

The pre-send guard does not predict future order-book availability or guarantee a fill
price. It does not change the stop to manufacture an attractive RR. Network time after
the final synchronous check remains an execution risk.

## Observational Economic Candidate

`reaction-entry-1-shadow` runs beside the baseline in the existing evaluator, with
no execution port or strategy-router registration. Exceptions are isolated from
the baseline decision. Every evaluated context produces a paired comparison log,
including rejected contexts, under `micro_burst_entry_candidate_comparison` with
`authority: OBSERVATION_ONLY`.

- Evaluate LONG and SHORT independently, recomputing BTC conflict for that side.
  Do not use support-first branch order to deny a qualifying SHORT.
- Require a current closed directional response and complete, gap-free signed flow.
  Proximity alone is not a reaction. Both entry and destination levels must have
  been available before the trigger candle opened; future candles are excluded.
- Separate `RECLAIM_REVERSAL`, `TREND_RETEST_CONTINUATION` and
  `BREAKOUT_RETEST_CONTINUATION`. A role-reversed level needs a closed breakout after
  pivot availability, then a different retest candle. It is not an unconfirmed pivot.
- Count touching runs as single visits, separated by departure on the defended side.
  Compare rejection displacement between independent visits and reject weakening
  defense. Report relative visit volume instead of treating any positive volume as
  proof of absorption. Volume is diagnostic, not a newly tuned weight.
- Bound the destination before the opposing level using the existing 2 bps cost-cover
  buffer. From executable ask/bid, subtract the existing 14 bps cost budget as residual
  friction and require net room >= existing 30 bps minimum and net RR >= existing 1.5.
  Add the same costs to adverse risk; report a doubled-cost stress RR separately.
  Do not add spread again. The budget is a conservative assumption, not actual fees,
  a measured impact curve, or a funding reconciliation.
- Emit deterministic visit episode IDs for deduplication. Candidate logs are repeated
  observations, not independent completed trades. Deduplicate before statistical analysis.

Candidate economics explicitly say `quantityCoverage: TOP_OF_BOOK_ONLY`. There is no
candidate account allocation or simulated fill at the approved 90% margin fraction.
The active baseline guard checks actual intended quantity, but this does not establish
candidate quantity-adjusted net profitability. The live baseline version/config hash
remain unchanged; candidate semantics have their own version. The deployment revision
binds the reviewed safety source separately through the existing exact SHA approval.

## Validation And Promotion Limit

Deterministic tests compare unchanged baseline and candidate on identical synthetic
contexts: proximity-only rejection, cost-adjusted rejection despite acceptable gross
RR, mirrored reclaim, both-near SHORT, separate trend/breakout retests, degrading
independent visits, future entry/destination confirmation, stale/gapped flow and stable
episode identity when future candles are appended. These are mechanics, not historical
out-of-sample performance. Lost-ACK, restart, manual-positive paths and actual durable
PREPARED-expiry races are covered by the execution/recovery suites.

The available raw trade/depth archive and existing signal outcomes do not by themselves
establish a paired, complete, chronological multi-timeframe candidate replay with
latency, intended quantity, funding and matched outcomes. This change does not fabricate
missing 3m/5m contexts or report synthetic tests as training/validation/test returns.
Untouched-test net expectancy, win rate and superiority are NOT MEASURED. Economic
promotion remains blocked by the acceptance criteria in
`STRATEGY_OWNERSHIP_ENTRY_PROPOSAL_2026_09_07.md`; the candidate is not enabled for LIVE orders.

Verification commands use an external build directory until the final deployment:

```sh
npm run build -- --outDir /tmp/opencode/micro-entry-build
AEGIS_ENABLED=true REGIME_CONFIG=regime_config.live.yaml npx vitest run --silent --reporter=dot --exclude src/infra/config/ConfigLoader.aegis-symbols.test.ts --exclude src/core/risk/ExecutionJournal.test.ts
AEGIS_ENABLED=true REGIME_CONFIG=regime_config.live.yaml npx vitest run src/core/risk/ExecutionJournal.test.ts --silent --reporter=dot
env -u REGIME_CONFIG AEGIS_ENABLED=true npx vitest run src/infra/config/ConfigLoader.aegis-symbols.test.ts --silent --reporter=dot
```

`AEGIS_ENABLED=true` above is only an isolated test-process fixture default for older
Aegis mock tests, not a production environment edit. Production remains false.
The main run passed 2,230 tests in 196 files; journal tests passed 264 and isolated
configuration tests passed 46, for 2,540 tests in 198 files. The source restoration
checkpoint is updated for reviewed TradingService bytes, not to bypass LIVE approval.

## Deployment Contract

The bounded pre-deployment audit completed five allowlisted authenticated GETs:
zero live positions, zero open regular/algo orders, no mutations/retries/redirects.
This is current flatness only. ADA still has unverified Micro PnL and ambiguous
entry/stop evidence; other symbols retain ambiguous-entry flags. No flags were cleared.

Commit only reviewed source/tests/docs, then bind `GIT_COMMIT_SHA` and the separate
`MICRO_BURST_APPROVED_COMMIT` to that exact final clean commit. Preserve effective
Micro config hash `093ab31d5531272246e7d408c0351d3a41e7d3716deaa02bf25ba39a43db2f1b`.
Gracefully stop only `01-Trading-Bot` with its existing 30,000 ms kill timeout,
verify successful shutdown and ordinary lock release, build committed source, and
restart with exact approval. Never remove active locks or repair evidence to start.
Keep `02-Aegis-API` stopped and `AEGIS_ENABLED=false`. Inspect fresh startup authority,
feed diagnostics, repeated health and pending-safety reasons; online alone is not health.
Deployment observations and the exact resulting commit/PID are reported to the owner
after verification, not guessed here before the commit exists.
