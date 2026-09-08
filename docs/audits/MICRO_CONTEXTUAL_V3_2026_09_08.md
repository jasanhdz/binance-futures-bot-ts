# Micro Contextual V3 Research Implementation

## Scope And Authority

Branch: `work/micro-context-intelligence-v2-20260908`, based on `6e108bc`.
The incoming diagnostic edits in `MicroBurstShadowEvaluator.ts` and
`MicroBurstReactionEntryPolicy.ts` are retained. This request authorizes branch/code
work only, not the deployment authorization recorded in older audit documents.
No commit, push, restart, exchange request, operational YAML/.env edit, live journal
repair, or approval update is part of this implementation. Builds go outside `dist`.

The optional domain setting `contextualPolicyVersion: 'CONTEXTUAL_V3'` selects the
new research policy. The YAML parser accepts `exit_policy.contextual_policy_version`
for an explicitly configured research runtime. Omission preserves the existing
configuration representation and legacy entry/exit policy. No default enables V3.
The parser rejects an explicitly configured V3 policy in LIVE mode; the entry router
also rejects V3 in LIVE mode for programmatic callers. The position manager evaluates V3 without
calling close/move-stop ports or replacing operational persisted exit state.
These restrictions are deliberate; a matching historical identity cannot promote V3.

## Implemented Phases

- Read-only authority diagnostics distinguish declared commit/config agreement from
  explicitly verified artifact evidence. A dirty source or unverified artifact is
  not a successful attestation. The diagnostic never grants authority or rewrites hashes.
- `evaluateMicroBurstStructuralEntry` shares structural geometry, room/RR and leverage
  selection without inheriting BASELINE-specific clarity/continuation gates. BASELINE
  ordering and behavior remain unchanged. V3 REACTION owns its market, side-specific
  BTC, directional response, signed-flow, visit and anti-lookahead checks.
- V3 common rejects carry both side reasons; side-specific rejects retain diagnostic
  inputs. Closed candles and level availability are validated. Existing local detailed
  rejection diagnostics are preserved, not replaced with an opaque score.
- V3 episode identity includes side, exact defended level/confirmation and visit start.
  The existing bounded duplicate guard accepts this identity rather than minute/cent
  rounding. Legacy IDs remain usable by existing consumers. This guard is in-memory,
  not a durable order-idempotency replacement. A revised confirmed level is a new
  structural identity; continuity across changing pivot clusters is not established.
- `sizeMicroBurstLossBudget` reuses the shared loss/margin/quantity rounding engine.
  USDT loss budget is mandatory. There is no guessed `maxRiskPct`, no conversion of
  the 90% margin fraction into a loss fraction, and no account read. Quantity is capped
  by stressed structural loss, explicit available margin, exchange filters, visible
  depth and any earlier quantity ceiling. Minimum notional never causes rounding up.
- Leverage is bounded by the explicit approved cap, existing domain cap and a 30x
  research ceiling. A 20x approval still forbids 30x. At a binding loss budget, moving
  from explicitly approved 20x to 30x reduces required margin, not monetary loss size.
  No existing LIVE cap or 20x/40x legacy tier is changed.
- Liquidation boundary and stop stress are mandatory caller evidence. A stressed stop
  beyond liquidation is rejected. The calculation does not pretend that `1/leverage`
  captures maintenance tiers, cross-margin exposure or liquidation fees. Worst visible
  entry pricing intentionally under-allocates and final VWAP/net-room admission is reused.
- `evaluateMicroBurstContextualProposal` composes reaction and sizing, with a non-live
  identity and an observation-only result. Research eligibility is not a fill or order.
- `microBurstExecutableExitEconomics` calculates the full quantity-covered exit-side
  VWAP. Costs and volatility are explicit inputs. Missing/stale/insufficient depth
  produces no quote, never an entry-price/last-price fallback or fabricated execution.
- `advanceMicroBurstExit` and `MicroBurstExitEngine` retain the existing five evidence
  families and hysteresis. V3 tracks executable MFE, adapts giveback to volatility,
  structural risk and continuation support, and never widens an existing stop. Unknown
  stop price is not permission to synthesize a profit-lock replacement.
- One supportive target extension requires a distinct, previously confirmed opposing
  obstacle and positive net room. The bounded destination is retained in serializable
  reducer state; another obstacle cannot create an unlimited chain of extensions.
- Absolute maximum hold precedes profit-lock requests and extensions. A separate clock
  deadline works without market prices. V3 missing-market routing reaches this research
  observation instead of silently suspending it. UNKNOWN ownership/stop supervision
  still returns through the existing safety path before strategy evaluation.
- Missing executable economics have a bounded blind window. Observation gaps reset
  reversal confirmation; a new quote cannot confirm the same repeated price/flow window.
  Hard structural invalidation/anomaly facts retain emergency precedence. These are
  policy decisions, not guarantees that an exchange close succeeds within the deadline.
- Existing logger composition receives bounded, asynchronous `micro_burst_exit_decision`
  records for decisions and application results, including HOLD/protection/close,
  identity and available inputs. Sink exceptions cannot change risk decisions; a stuck
  sink is capped at 64 in-flight records and exposes failed/dropped/pending counters.
  V3 decisions include timestamps, flow-gap status and explicit non-probability labeling.

## Economics And Evidence Limits

The evidence weights remain PRICE 35%, FLOW 25%, BOOK 15%, BTC 15%, STRUCTURE/TIME 10%.
They are heuristic scores, not calibrated probabilities or ML predictions. Giveback
uses existing protection/risk parameters and explicit volatility, not many new tunables.
These rules are hypotheses requiring chronological out-of-sample evaluation.

Exit VWAP already includes the observed spread/depth effect. Residual fees, funding
and additional stress must not count that spread again. `maxLoss` is a stressed model
estimate, not a guaranteed maximum loss under gaps, latency or disappearance of depth.
Caller-supplied residual costs cannot be below the existing configured cost budget.

Decision records explicitly leave realized net PnL null. Existing actual-fill/outcome
journals remain the source of settlement, joined by trade identity. `actionApplied`
alone does not establish matched fills, entry fees, funding or accounting completeness.
This patch does not fabricate a complete training corpus, repair ADA PnL, clear durable
quarantines, reinterpret manual ownership, or remove paper engines with real consumers.

## Not Activated Or Not Established

- No running artifact/PM2/environment attestation was performed. Runtime authority is
  not inferred from the source LIVE flag, process labels or historical audit approvals.
- Account-risk approval, conservative liquidation-tier evidence and a live quantity-aware
  economics/volatility adapter remain prerequisites to any future execution integration.
  The production market reader does not automatically fabricate the new required inputs.
- No production deployment or promotion path is enabled for V3, including its exit actions.
- No paired chronological multi-symbol replay, purged/embargoed OOS performance, cost/latency
  calibration, power analysis or prospective coverage acceptance has been established.
  Small consistent net wins, superiority, a high win rate and profitability are not guaranteed.
- Durable deduplication across restarts, evolving-cluster episode continuity and a complete
  decision-to-fill-to-funding dataset are not claimed by the in-memory observation helpers.

## Verification And Existing Blocks

Tests cover mirrored reaction, baseline independence, LIVE denial, explicit loss caps,
20x/30x risk invariance, depth/rounding/liquidation rejection, executable MFE, adaptive
noise tolerance, corroborated reversal, persistence/gaps, clock deadlines, target bounds,
UNKNOWN protection and bounded/failing observers. Unit fixtures are synthetic mechanics.

The first full run passed 2,262 tests and failed two integrity assertions in 199 files.
The separately isolated configuration suite passed 46 tests; the execution journal
passed 264 on an isolated rerun without worker errors. The parallel journal attempt had
a worker RPC timeout and is not counted as a clean validation run.

The two integrity assertions are intentionally not unlocked:

- Effective Micro config at original HEAD, using its original loader/YAML, hashes to
  `957d53b90e8d57eb9233e468722e85786a42a9244dc88b6cd66fc485421aa3ba`.
  The approved constant/test expects
  `093ab31d5531272246e7d408c0351d3a41e7d3716deaa02bf25ba39a43db2f1b`.
- Original HEAD YAML hashes to
  `970ce7308d7ec0cd49e97e032491dc0b50901c8ab4300746ebff6968d83ce730`,
  while the restoration assertion expects
  `18c8584ac780bf3a1d34f90974dc4527b9c7116de79fdf9a927538ec89e33e4c`.
  This change also intentionally edits TradingService source for observation wiring;
  its source checkpoint will require review separately. No approval/checkpoint was changed.

Commands, all offline test processes rather than bot startup:

```sh
npm run build -- --outDir /tmp/opencode/micro-context-v3-build
npx vitest run src/strategies/micro-burst --silent --reporter=dot
AEGIS_ENABLED=true REGIME_CONFIG=regime_config.live.yaml npx vitest run --silent --reporter=dot --exclude src/infra/config/ConfigLoader.aegis-symbols.test.ts --exclude src/core/risk/ExecutionJournal.test.ts
AEGIS_ENABLED=true REGIME_CONFIG=regime_config.live.yaml npx vitest run src/core/risk/ExecutionJournal.test.ts --silent --reporter=dot
env -u REGIME_CONFIG AEGIS_ENABLED=true npx vitest run src/infra/config/ConfigLoader.aegis-symbols.test.ts --silent --reporter=dot
```

`AEGIS_ENABLED=true` here supplies historical test fixtures only; no operational file
or process environment was changed. See the final verification update below for counts
after the last additions.

## Final Verification

- Targeted Micro plus TradingService safety contracts: 523 tests passed in 41 files.
- Final main run: 2,274 tests passed and the same two integrity assertions failed,
  in 200 files. No new behavioral failure remains in this run.
- Isolated config: 46 passed; isolated execution journal: 264 passed.
- Combined non-overlapping suite result: 2,584 passed, 2 failed, 202 files.
- Final TypeScript build passed with output at `/tmp/opencode/micro-context-v3-build`.
- Intended-file Prettier formatting and `git diff --check` passed.
- No staged files, commit or push. No edits to operational YAML, `.env` or `dist`.

The prototype-only TradingService safety fixture now supplies its runtime-config
dependency and tests both legacy missing-market return and V3 research routing.
Existing initial identity-version and mirrored baseline fixture inconsistencies were
corrected without changing approved hash constants or baseline entry economics.

The entire proposed production redesign is not declared complete: the missing live
evidence adapters, durable episode continuity, settlement dataset and economic validation
listed above remain outside this research implementation. No test result establishes
current production authority or permission to enable the candidate.
