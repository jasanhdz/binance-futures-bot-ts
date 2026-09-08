# Micro Contextual V3 Research Implementation

## Existing Operator Ledger Check

After publishing source integration commit `43474a3`, an explicitly invoked local
INITIALIZE attempt failed with `MICRO_NET_LOSS_SCOPE_OR_KEY_MISMATCH`. Read-only SQL
inspection at `2026-09-08T16:11:24.614Z` established that the production V3 ledger was
already initialized: revision 1, epoch 1, streak 0, halt false, zero pending settlements
and one signed command. The public key at
`data/runtime/micro-operator/operator.public.pem` matches the ledger's pinned SPKI
SHA-256 `ecc5440563cda6f080f75c2de083562101cbbd610f079e80f5163b899f2ff843`.
The retained earlier initialization command explicitly describes local owner approval
of the 90%/20x-30x/three-net-loss trial, without a legacy quarantine reset.

No new initialization or reset was applied. The unsuccessful attempt generated an
unused, unpinned pair under `/home/jasan/.config/micro-burst-owner/`; only those newly
created PEM files were removed. The original pinned keys and signed record were not
modified. The CLI now refuses a new key location for an existing scoped database
before generating another pair. Its offline regression also checks this refusal.
The existing ledger and operator directory are ignored by Git and were not staged.

This resolves the earlier uncertainty about whether operator initialization exists;
it does not clear ADA, attest live account history or approve a deployment. No `.env`
key path or approved commit/config hash was changed, and no PM2 restart was performed.

Follow-up verification: `AEGIS_ENABLED=false npx vitest run
src/tooling/micro-burst/MicroNetLossOperator.test.ts
src/app/bootstrap/MicroNetLossComposition.test.ts
src/infra/state/MicroBurstNetLossLedger.test.ts --silent --reporter=dot --maxWorkers=1`
passed 28 tests in three files. These overlap the integration suite below and are
not added to its count. The external-directory build and `git diff --check` also
passed after the operator precheck change.

## Production Flow Integration Follow-Up

The resumed workspace contained an uncommitted integration over `d8d2de5`. This
increment reviews and completes additional production connections, without claiming
a deployed or exchange-validated V3 runtime:

- Shared execution now requires the trusted contextual sizing port and durable entry
  and stop coordinators. Binance supplies signed account commission rates, available
  USDT wallet collateral, isolated one-way position evidence, liquidation fees and
  continuous maintenance-tier coverage. Unknown evidence denies entry. Margin plus
  explicit fee reserve fits inside 90% of available wallet; supported tiers are 20/30,
  not 40, with no separately invented dollar loss budget. The stressed liquidation
  boundary is conservative modeling, not a guaranteed liquidation or loss price.
- Validated account/book/sizing evidence is copied into the intent before durable
  PREPARED, bound to policy digest, symbol, side and quantity. Account freshness is
  checked again by the coordinator's pre-submit callback. Production admission also
  requires exit-cost, settlement, triggered-stop and fresh-position capabilities.
- Normal entry supplies the resolved policy and causal episode. The evaluator now
  propagates the router's actual version instead of relabeling V3 signals as REACTION
  0.9. The shared loss-streak gate uses V3's ledger and three-loss threshold rather
  than the legacy session streak. Other existing admission protections remain.
- Executable exit economics use quantity-covered book depth, actual opening fees,
  current signed taker fees and bounded funding coverage. Missing evidence advances
  the persisted blind timer without synthesizing prices or MFE. Full history pages
  in this exit estimator are rejected, not silently treated as complete; final
  settlement retains the separately implemented exhaustive pagination path.
- The next opposing obstacle is read from validated closed 5m candles using the
  stored trade policy's S/R parameters. Only a prior-confirmed next level is supplied
  to the reducer's existing single-extension rule. Missing/stale/gapped data supplies
  no obstacle. Exit actions require the stored policy and durable execution ports.
- Stop tightening has a policy-bound mutation identity, preserves the old covering
  stop while observing the new one, persists its active key, and resumes pending
  adjustment observation during normal supervision. UNKNOWN does not permit resend;
  a failed projection flush retains the pending adjustment. Triggered stop attribution
  requires the exact conditional algo, actual executed order and complete quantity.
- The operator-only initialization CLI generates genuine local-owner Ed25519 keys
  with private permissions, records `LOCAL_OWNER_GENERATED_ED25519` provenance and
  signs an INITIALIZE command. It refuses reinitialization of a known ledger; the
  runtime does not import private keys or auto-reset the loss latch. This is local
  owner signing, not independent or third-party approval. Operational invocation is
  separate from the offline fixtures and is not implied by their success.

The integrated simulated-Binance tests exercise entry, confirmed protection, durable
close, triggered-stop accounting and three net losses. Restart now reopens FsStateStore,
SQLite and all three execution journals and reconstructs their coordinators. Tests
also cover blind-clock recovery and observation-only recovery of an ambiguous stop
adjustment. A signal-evaluator regression separately checks V3 version/episode/tier
propagation; the flow fixture does not claim to simulate the complete live feed or
construct the entire TradingService bootstrap.

### Verification

All test processes used `AEGIS_ENABLED=false`:

```sh
AEGIS_ENABLED=false npx vitest run src/strategies/micro-burst src/app/execution/DurableEntryCoordinator.test.ts src/app/execution/DurableCloseCoordinator.test.ts src/app/execution/DurableStopCoordinator.test.ts src/app/execution/SharedStrategyExecutionService.test.ts src/app/position/MicroEntryRecoveryService.test.ts src/app/position/PositionProtectionService.test.ts src/app/runtime/StrategyRuntimeCoordinator.test.ts src/infra/state/MicroBurstNetLossLedger.test.ts src/app/services/TradingService.safety-contracts.test.ts src/app/services/TradingService.micro-settlement.test.ts src/app/services/TradingService.contextual-flow.test.ts src/app/bootstrap/MicroNetLossComposition.test.ts src/app/bootstrap/DurableCloseComposition.test.ts src/infra/adapters/BinanceAdapter.settlement.test.ts src/infra/adapters/BinanceAdapter.brackets.test.ts src/infra/adapters/BinanceAdapter.contextual-risk.test.ts src/tooling/micro-burst/MicroNetLossOperator.test.ts src/tooling/micro-burst/MicroBurstContextualPreflight.test.ts --silent --reporter=dot --maxWorkers=1
AEGIS_ENABLED=false npx vitest run src/restoration/original-operational-semantics.test.ts -t 'operational sources|current-brain contract exception|branch bytes|out of the operational path|exit sources' --silent --reporter=dot --maxWorkers=1
AEGIS_ENABLED=false npm run build -- --outDir /tmp/opencode/micro-contextual-wiring-20260908-build
git diff --check
```

Result: 931 tests passed in 60 files; five selected integrity checks passed, with 15
unrelated checks skipped. External compilation and whitespace validation passed.
Earlier attempts included one 120-second terminated run, nondeterministic real-clock
flow fixtures and a new candle-fixture/type error. Those attempts are not counted as
successful; explicit simulated clocks and corrected candle validation passed the
final commands above. No complete-repository or Aegis-suite success is claimed.

### Deployment Boundary

This is not V3 LIVE completion. The simulated exchange accepts coexistence of old and
new close-position stops; actual Binance acceptance of that tightening protocol is
not established. A rejected/unknown replacement retains the prior stop and pending
identity, but this does not prove the requested adaptive stop can be installed on
Binance. No manual real-money order was sent to test that assumption. Complete live
bootstrap/feed-to-order validation, artifact/config approval, deployment and runtime
monitoring remain outstanding. The local preflight reports these validation gaps
instead of claiming the now-implemented fee/sizing/exit adapters do not exist.

Read-only PM2 inspection at `2026-09-08T15:52:16.887Z` found `01-Trading-Bot` online,
PID `627698`, kill timeout 30,000 ms, and `02-Aegis-API` stopped. This is process
metadata, not source/artifact attestation. Local ADA state remains IDLE with
`marketOpenAmbiguous=true` and `microBurstPnlUnverified=true`, without a complete V3
policy/settlement identity. It is not retroactively adopted into V3 or cleared.
Operational YAML, `.env`, `dist`, process configuration, journals and quarantine were
not modified by this source/test increment. No current wallet amount or profitability
is inferred from historical state or the synthetic 25-USDT test fixture.

## Runtime Accounting Wiring Follow-Up

This source increment connects production accounting paths, but does not complete
or enable V3 LIVE:

- `BinanceExchange.readMicroBurstSettlement` queries exact order identities, both
  commission legs, user trades, funding income and fresh flat positions. It uses
  the shared request queue with endpoint weights, server-clock observations, a
  seven-day maximum interval, conservative 90-day history cutoff, and at most 16
  combined trade/income page reads. Full pages are divided into disjoint inclusive
  time windows; a saturated millisecond or exhausted budget remains unverified.
  No order mutation or market-order retry is part of this read capability.
- Attribution currently requires one-way BOTH orders, exact complete quantities,
  USDT commissions/funding and no foreign trades in the interval. Hedge attribution,
  unsupported assets, partial terminal orders, missing numeric fields, ambiguous
  boundary funding and unavailable endpoint evidence remain unverified. Empty
  exhaustive income coverage, not an absent response, establishes zero funding.
- `DurableCloseCoordinator` persists the policy/episode-bound exact close accounting
  identity before the operational close can become terminal. Entry recovery retains
  the episode and pre-submit interval start from its existing entry journal, rather
  than incorrectly using the later position-confirmation timestamp to query fills.
  Missing historical snapshots are not adopted or synthesized.
- `TradingService` composes the ledger into V3 admission and the final pre-submit
  callback. Its startup/watchdog accounting worker records pending settlement before
  exchange reads and only releases the matching V3 accounting quarantine after
  verified durable accounting and a state flush. A failed flush restores the
  in-memory quarantine. Work is single-flight and tracked for graceful shutdown;
  accounting endpoint failures do not disable stop supervision or send close retries.
- `MicroNetLossComposition` opens independent critical SQLite storage under the
  private, owned `data/runtime/micro-net-loss/` directory. Scope includes a SHA-256
  API-key fingerprint and normalized production/testnet environment; credentials
  are not printed or stored. Credential rotation deliberately requires a separately
  signed new scope initialization, not an automatic account-ledger migration.
  `MICRO_NET_LOSS_OPERATOR_PUBLIC_KEY_FILE` names an external PEM Ed25519 public key.
  Missing key/initialization blocks V3; the bot neither signs nor auto-resets it.
- Integrated offline tests exercise the real TradingService accounting worker,
  Binance adapter methods with a simulated client, FsStateStore and SQLite ledger.
  They cover three net losses, restart, post-halt win, exact tie, pre-halt win,
  pending-before-read, missing funding, replay, unsupported ownership/policy and
  failed quarantine-clear persistence. Separate durable-close tests cover the
  retained accounting identity and send-once recovery.

Remaining work is still material: production contextual sizing/liquidation-tier
and cost evidence, entry-orchestrator policy/episode supply, executable exit
economics, authorized durable V3 exit application, stop-trigger accounting routing,
and the complete entry -> confirmed stop -> exits -> three-loss admission test.
The parser/router/position-manager LIVE denials are not removed. Passing accounting
integration tests is not a substitute for that missing full-flow test or deployment.

Source integrity checkpoints are updated only for the reviewed Exchange port,
Binance adapter and TradingService changes. No LIVE approval/config hash is changed.
The operational YAML, `.env`, `dist`, existing ADA quarantine and PM2 process are
untouched. Read-only PM2 metadata still shows `01-Trading-Bot` PID 627698 online and
`02-Aegis-API` stopped; this does not attest the current artifact or V3 authority.
No live account request, real test order, deployment or five-minute monitoring was
performed. Economic profitability is not validated.

Final offline verification for this increment:

```sh
AEGIS_ENABLED=false npx vitest run src/strategies/micro-burst src/app/execution/DurableEntryCoordinator.test.ts src/app/execution/DurableCloseCoordinator.test.ts src/app/execution/DurableStopCoordinator.test.ts src/app/execution/SharedStrategyExecutionService.test.ts src/app/position/MicroEntryRecoveryService.test.ts src/infra/state/MicroBurstNetLossLedger.test.ts src/app/services/TradingService.safety-contracts.test.ts src/app/services/TradingService.micro-settlement.test.ts src/app/bootstrap/MicroNetLossComposition.test.ts src/app/bootstrap/DurableCloseComposition.test.ts src/infra/adapters/BinanceAdapter.settlement.test.ts src/infra/adapters/BinanceAdapter.brackets.test.ts --silent --reporter=dot --maxWorkers=1
AEGIS_ENABLED=false npx vitest run src/restoration/original-operational-semantics.test.ts -t 'operational sources|current-brain contract exception|branch bytes|out of the operational path|exit sources' --silent --reporter=dot --maxWorkers=1
AEGIS_ENABLED=false npm run build -- --outDir /tmp/opencode/micro-runtime-accounting-20260908-build
git diff --check
```

Result: 857 tests passed in 53 files; five selected source-integrity checks passed
(15 unrelated checks deliberately skipped). External-directory compilation and
whitespace checks passed. The earlier type-check caught two test-fixture type errors;
both were corrected before the final build. No full-repository or Aegis-suite
success is claimed. Every test process used `AEGIS_ENABLED=false`.

## Durable Contract Follow-Up

The next source increment adds these contracts without changing deployment approval:

- `micro_burst.contextual_risk` parses an explicit `MARGIN_FRACTION` policy with
  `margin_fraction`, `medium_leverage`, `high_leverage`, `max_consecutive_net_losses`,
  `reset_mode`, `fee_reserve_bps`, and `stop_stress_bps`. The accepted trial tiers are
  20/30, the maximum margin fraction is 0.9, the loss threshold is three and reset
  mode is `SIGNED_OPERATOR`. No dollar loss budget is required. Fields are explicit;
  no observed config becomes an approval. This optional section participates in the
  effective config hash. Existing configurations without it retain their representation.
- `MicroBurstTradePolicy` captures the resolved config, risk policy, source config
  hash and full source commit with a canonical digest. Existing confirmation thresholds
  select 20/30 for this snapshot; they are heuristic inputs, not probabilities. The
  legacy high tier remains unchanged. Recovery copies the journal's policy and rejects
  invalid identity/digest rather than adopting latest configuration. V3 exit observation
  uses the stored policy and binds persisted reducer state to its digest with a flush.
- `DurableEntryCoordinator` identifies explicit V3 mutations by account, environment,
  symbol, side and exact episode. A new trade/client ID or config hash does not reopen
  an already recorded episode. PREPARED is flushed before sending; UNKNOWN remains
  observation-only on restart. V3 requires a valid policy snapshot. Legacy operation IDs
  are preserved. These tests do not establish evolving pivot-cluster continuity.
- `reconcileMicroBurstSettlement` requires complete exact-order fill attribution,
  quantity coverage, opening and closing commissions in USDT, complete funding coverage,
  and identified order/flat evidence. Missing fees, unsupported fee assets, partial pages,
  foreign fills and ambiguous funding produce UNVERIFIED/null. An exhaustive funding
  interval with no events can establish zero funding; an absent interval cannot.
- `MicroBurstNetLossLedger` stores accounting and loss checkpoints in an independently
  scoped SQLite WAL database using FULL synchronous transactions. Unknown closes remain
  pending. Three confirmed net losses latch the stop; midnight, restart, subsequent wins
  and replay do not release it. A confirmed win resets the pre-halt streak; exact zero
  does not count as a win. Duplicate fills/income cannot be attributed to another trade.
  Conflicting accounting is quarantined. New evidence polls may change observation time
  or row order without creating a false conflict. The adapter rejects oversized evidence
  and caps trade records at 100,000 rather than pruning critical history.
- Initialization and reset require externally signed Ed25519 commands bound to account,
  environment, policy, revision, nonce and a short validity window. The bot generates no
  operator signature. Pending/conflicting settlements prevent reset. The pinned public
  key is part of the database identity. No existing operational ledger is migrated,
  initialized, reset or cleared by this source increment.

Verification, with Aegis disabled in every test process:

```sh
AEGIS_ENABLED=false npx vitest run src/strategies/micro-burst src/app/execution/DurableEntryCoordinator.test.ts src/app/position/MicroEntryRecoveryService.test.ts src/infra/state/MicroBurstNetLossLedger.test.ts src/app/services/TradingService.safety-contracts.test.ts --silent --reporter=dot --maxWorkers=1
npx tsc -p tsconfig.json --noEmit
git diff --check
```

Result: 653 tests passed in 45 files; TypeScript and whitespace validation passed.
No complete repository/Aegis suite or profitability validation is claimed. Tests use
synthetic exchange ports and temporary databases, not real orders or operational journals.

### Remaining Integration Work

This increment is not V3 LIVE completion. The new ledger is not composed into
TradingService's admission/settlement path. No production Binance adapter supplies the
new exhaustive fill/funding proof or pre-entry liquidation-tier evidence. Shared execution
still uses its existing sizing path, not the contextual margin-sizing evidence contract.
The parser, router and position-manager V3 LIVE denials remain. The policy snapshot and
episode contracts must be supplied by the production entry orchestrator, and prospective
dataset export and executable exit economics still need their live evidence adapters.
An end-to-end test of that complete production route has not been established.

No operational YAML, `.env`, approved hashes, `dist`, PM2 process or ADA quarantine was
modified. No fresh process/artifact/book/exposure attestation was performed in this
increment. No subagent tool is available in this session; independent reads and validation
commands were parallelized. Deployment and five-minute live monitoring were not performed.

## Margin-Fraction Follow-Up

The subsequent operator request authorizes a 90% available-wallet margin allocation,
20x/30x leverage, and a durable stop after three confirmed consecutive net losses.
It does not require an independently chosen USDT loss budget. The older mandatory
loss-budget prerequisite below is superseded for explicit `MARGIN_FRACTION` proposals.

The offline sizing input now accepts `sizingMode: 'MARGIN_FRACTION'`,
`availableWallet`, `marginFraction`, and `feeReserveBps`. It rejects allocations above
0.9, nonfinite inputs, conflicting loss/margin budgets, unknown modes, and leverage
outside 20x/30x or above the separately supplied approved/domain cap. The supplied
reserve must cover at least the supplied residual-cost estimate. Margin plus that
reserve fits within the allocation; the unused wallet fraction is not a loss budget.
Structural-stop stress, caller-supplied liquidation evidence, quantity/notional
filters, depth, freshness and executable-room checks remain mandatory. `maxLoss`
is the shared result's estimated stressed structural loss, not a guaranteed loss
ceiling. At 30x it can exceed the estimate at 20x. Existing loss-budget callers retain
their behavior. Neither mode reads an account or sends an order.

Verification for this follow-up:

- `AEGIS_ENABLED=false npx vitest run src/strategies/micro-burst --silent --reporter=dot --maxWorkers=1`:
  529 tests passed in 40 files, including 19 added margin-mode cases.
- `npx tsc -p tsconfig.json --noEmit`: passed; no output written to `dist`.
- `git diff --check`: passed.
- Aegis and the complete repository suite were not tested; no all-suite claim is made.

Read-only PM2 inspection found `01-Trading-Bot` online with PID 627698 and
`02-Aegis-API` stopped. This is process metadata, not artifact or policy attestation.
No process, operational YAML, environment, deployment approval, account or journal
was modified. No account balance or exposure was queried. No subagent facility was
available; independent verification commands were parallelized instead.

This follow-up is not completion of V3 LIVE. Runtime YAML wiring for this sizing
mode, live account/tier evidence, durable net-loss latch, policy-bound recovery,
durable episode send-once integration, executable exit adapters and reconciled
fill/fee/funding datasets remain unimplemented or unverified by this change. Parser,
router and position-manager LIVE restrictions are preserved. No production
activation, real-money operation, five-minute runtime validation, or profitability
claim follows from these offline tests. Existing ADA quarantine is untouched.

## Integration Update

The later user request explicitly authorizes publishing the context branch, merging
it into `work/micro-burst-rider-v1-20260826`, and rebuilding/restarting the existing
LIVE policy. The research-only scope and verification statements below describe the
original implementation, not this subsequent integration.

Source `cc83be6` was pushed to the context branch before merging into `bf6089f`.
The target already approved effective REACTION config
`957d53b90e8d57eb9233e468722e85786a42a9244dc88b6cd66fc485421aa3ba`.
That approval and the exact YAML checkpoint are preserved; tests still reject
representation drift and mismatched deployment commits. TradingService's reviewed
source checkpoint includes bounded exit observation and research-only missing-market
routing, without changing its managed-close or protection contracts. The V3 preflight
now stores its historical config baseline explicitly instead of importing the mutable
current deployment approval. Historical drift is not a current REACTION authority failure.

V3 remains blocked in LIVE at the parser, router and position-manager mutation boundary.
No monetary budget is invented, no leverage/margin defaults are changed, and no
ownership, UNKNOWN-stop or unverified-PnL state is repaired or cleared by this merge.
LIVE V3 still requires the evidence adapters, explicit risk approval and validation
listed below; approval of this deployment is not approval of V3 execution.

Integration verification: 557 targeted tests passed in 43 files. The final complete
run `AEGIS_ENABLED=true npm test -- --silent --reporter=dot --maxWorkers=1` passed
2,615 tests in 203 files with no unhandled errors. A previous parallel run had one
historical-baseline assertion failure and a worker RPC timeout; it is not a clean run.
The Aegis setting was confined to offline test processes, not the operational environment.
TypeScript compiled successfully outside `dist` before the planned deployment stop.
Deployment PID, exact revision and runtime readiness must be verified after restart;
neither this source note nor passing tests attest a running artifact.

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
