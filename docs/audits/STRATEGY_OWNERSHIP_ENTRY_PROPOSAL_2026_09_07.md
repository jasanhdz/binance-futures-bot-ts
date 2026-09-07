# Ownership Review And Entry Experiments

## Scope

Follow-up to `ADA_MICRO_TRADE_2026_09_07.md`. Existing uncommitted audit edits were preserved. This review changes recovery correctness and tests only. No production restart, deployment, configuration edit, order, journal repair, quarantine release, commit or push is authorized here.

## Ownership Contract And Findings

| Position evidence                                                   | Routing and protection                                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| External position without conflicting local or pending bot evidence | EXTERNAL / MANUAL_EXTERNAL, excluded from bot metrics; complete missing manual SL/TP when required              |
| Verified Micro identity                                             | Micro structural stop and Micro exit manager; no manual TP or manual ROE substitution                           |
| Verified Momentum identity                                          | Momentum protection profile and lifecycle, not Aegis entry/exit authority or manual overrides                   |
| Pending entry, uncertain API result, accounting quarantine          | Preserve evidence and block manual adoption; reconcile exact durable identity, never infer permission to resend |
| Active incomplete or unknown local identity                         | Leave unresolved, report recovery requirement, do not invent manual ownership or brackets                       |

`MANUAL_EXTERNAL` identifies the external-management route, not proof that a human clicked Binance. With a blank local state and no pending journal evidence, exchange position data alone cannot distinguish a human from another external program. Attribution remains `ownershipStatus: UNKNOWN`. If both local and durable bot evidence are lost, automatic source attribution is not established by this patch.

1. **Fixed previously, retained:** runtime adoption could run while a bot market entry awaited confirmation. `TradingService.ts:351` now connects admission to reservations and durable coordinator blocking; recovery rechecks after exchange awaits. This is the demonstrated ADA policy substitution, not evidence of an inverted Micro signal.
2. **Fixed in this follow-up:** startup marked incomplete bot ownership UNKNOWN, then continued into manual adoption. `PositionRecoveryService.attachOpenExchangePositionsToSymbolState` now stops immediately for a verified entry missing its order ID and refuses manual adoption of unresolved active state. Explicit external state is no longer first demoted through the legacy/unknown branch. Genuine external startup/runtime adoption still completes manual brackets.
3. **Remaining recovery limitation:** `MicroEntryRecoveryService.ts:29-50` reconstructs only Micro, and only a blank projection or an exactly matching recovered projection. Momentum reconstruction and occupied/incomplete Micro state remain recovery work, not permission to assume manual ownership. `DurableEntryCoordinator.ts:298-311` retains pending evidence until handoff is confirmed. Its admission block is global: unresolved bot evidence can delay otherwise legitimate external adoption on another symbol. Do not silently weaken this conservative boundary.
4. **Remaining execution limitation:** `TradingService.ts:398-403` checks lifecycle admission, stop/close blocks and LIVE mode, not signal age, current book/flow or executable geometry. `SharedStrategyExecutionService.ts:181-198` does more asynchronous work before durable submission. Evaluation-time FRESH is not send-time FRESH. The ADA audit measured 39.269 seconds from observation to PREPARED; this is not a calibrated TTL or a network-only measurement.
5. **Protection uncertainty is not successful protection:** Micro returns before its intelligent exit manager while stop evidence is UNKNOWN (`TradingService.ts:1977-1987`). This preserves mutation safety but can prevent the intended short-duration policy from running. Resolve exact stop/position evidence; do not replace it with manual brackets or claim the short hold is guaranteed.

Also fixed: recovery's verified-owner callback previously required `eligibleForBotMetrics: true`. The recovery wiring now checks ownership independently of metrics eligibility, without changing the existing accounting predicates elsewhere. Real TradingService startup tests preserve verified Micro and Momentum identities excluded from metrics; exclusion never grants manual authority.

Manual required brackets use stop ROE `-0.40`, TP ROE `+1.00` (`PositionRecoveryService.ts:7-8`), filling missing orders through `PositionProtectionService.ensureBrackets`. These are leveraged ROE fractions, not price percentages or guaranteed realized outcomes. `regime_config.live.yaml:109` has `require_brackets: true`; this is the inspected file, not a fresh attestation of the running process's loaded config.

Momentum's inspected YAML profile (`regime_config.live.yaml:458-478`) uses stop `-0.40`, TP `+0.50`, break-even `0.08`, trailing activation `0.10`, callback `0.08`, maximum hold 28,800,000 ms. The coordinator explicitly requests both stop and TP from its own profile (`MomentumEntryCoordinator.ts:341-372`). Micro requests structural protection, not those ROE defaults. None of these economics changed.

## Baseline Entry Policies

**Momentum:** `MainStackingMomentumStrategy.ts:23-70` requires at least 80 candles, three directional candles, each volume at least 1.1 times the preceding 20-candle average, approximately ascending volume, body/wick quality, EMA 7/25/99 alignment, extension from EMA25 at most 0.6%, and ATR at least 0.25%. `MomentumRideEntryPolicy.ts:110-198` adds fresh realtime/liquidity status, side enablement, exposure limits and shared safety. It is not a pullback/retest state machine. It does not require structural destination room or cost-adjusted RR; taker flow is recorded but is not a directional veto in this policy. Three consecutive expansion candles can arrive after much of the available move, despite the existing extension cap.

**Micro:** `MicroBurstEntryPolicy.ts:10-173` requires valid context, healthy book, BTC non-conflict, structural clarity, continuation strength, support/LONG or resistance/SHORT with matching momentum, both structural levels, valid stop/target geometry, minimum room and gross RR. Microregime is diagnostic, not a hard directional veto. `MicroBurstSupportResistance.ts:179-213` already filters candles by snapshot time and waits for right-side pivot confirmation; preserve this anti-lookahead contract. Strength currently combines touch count, pivot count and a positive-volume bonus (`:124-129`), not independent rejection quality or normalized absorption. If both levels are near, support wins by branch order (`:165-167`), not by comparative opportunity quality. Treat a change to that tie-break as an economic experiment, not an automatic bug fix.

## Experiment M: Momentum Continuation

Objective: capture a sustained favorable expansion without buying/selling an exhausted move. Keep current sizing, leverage, loss/exposure caps and owner-specific protection fixed for the entry comparison.

1. Identify a trend-aligned expansion using only available closed candles and fresh, gap-free executable market data. Record the broken level, expansion origin, confirmation time and invalidation before entry.
2. Compare two separately labeled setups: immediate expansion with remaining executable room, and the first qualified pullback/retest that holds the broken level then resumes with price and signed taker-flow confirmation. A pullback must create a new confirmed trigger, not reuse the old expansion timestamp.
3. Reject chasing when the executable ask for LONG / bid for SHORT has consumed the permitted displacement or destination room. Measure extension relative to both structure and volatility; choose any thresholds on training data only.
4. Compute a structural invalidation reference and the nearest confirmed opposing liquidity/price level. Require net room and acceptable executable RR under the existing actual protection profile, not an attractive hypothetical stop that the live policy will not place.
5. Preserve the current Momentum exit profile in the first comparison. A separate later experiment can compare a continuation runner against the fixed TP, with identical initial risk and no widening stops. Entry-only results cannot establish that a modified runner is better.

## Experiment U: Micro Level Reaction

Objective: more independent, short-lived executable opportunities near meaningful support/resistance, not more repeated alerts for the same touch.

1. Retain pivot confirmation timestamps. Score levels using independent visits separated by departure, rejection displacement, normalized volume, recency and evidence of weakening after repeated tests. Do not count five adjacent touching candles as five independent successful defenses.
2. Evaluate two explicit setup families: range reversal after a failed break/reclaim with flow turning toward the corridor, and trend continuation after a pullback/retest holds a confirmed level. Countertrend reversal needs its own reversal evidence; proximity alone is insufficient. Mirror LONG/SHORT conditions and evaluate both when both levels are near rather than favoring support by branch order.
3. Require a fresh favorable response: price leaves the defended level toward the destination, signed flow agrees, and executable depth/spread remain healthy. A stale reaction or a break of invalidation cancels that episode. Do not enter mid-corridor just because an earlier snapshot was near support/resistance.
4. Use the confirmed opposite level as a bounded destination, account for conservative exit execution before the crowded level, and retain the existing structural stop contract. Require positive cost-adjusted room and net RR at the executable quote and intended quantity. Reject opportunities that cannot cover round-trip friction within the intended short horizon.
5. Preserve current Micro exit intelligence for entry attribution. Separately test short proof windows/time decay and capped continuation extensions using observations after simulated fill, not before a live entry could exist. Unknown protection remains a safety state, not a strategy HOLD observation or an invented successful exit.

## Shared Pre-Send Contract (Proposed)

Persist signal/episode ID, strategy/config version, snapshot/observation/qualification times, expiry, source sequence/gap status, price reference, invalidation and destination. Before PREPARED and again immediately before the one authorized market send, revalidate ownership/reservation, current market freshness, unbroken invalidation, executable displacement and cost-adjusted room. Re-evaluation must not silently reverse side or replace the durable signal identity. If the setup expires, return a distinct no-send reason; a new setup needs a new qualified episode. After UNKNOWN, use exact reconciliation only, never a freshness-driven resend.

The existing durable `isEntryCurrent` callback is a suitable final synchronous admission boundary, but it currently lacks this market contract. Implement the contract and deterministic clock/race tests in an isolated experiment before enabling a TTL. No arbitrary TTL was added here.

For quantities expressed in bps, define net reward as gross executable target return minus entry/exit fees, spread/slippage not already included in executable prices, and attributable funding. Define loss as executable adverse stop return plus applicable costs; use net reward / loss. Avoid double-counting spread. Stop slippage and impact are uncertain, so also report stressed costs. A positive RR is not a positive expected value without a validated outcome distribution.

## Shadow Comparison And Acceptance

Run unchanged baseline, each entry variant separately, and only then a combined candidate on identical archived events. The shadow runner must have no exchange mutation port and must write outside live journals. Retain rejections as well as accepted signals; otherwise opportunity coverage and selection bias cannot be assessed.

Use chronological training/validation/untouched test intervals across multiple symbols, trends, ranges and stressed liquidity. Purge/embargo overlapping holding horizons; deduplicate by symbol, direction and structural episode. Freeze candidate rules and cost assumptions before the untouched test. ADA is diagnostic evidence, not a training target.

Report independent episodes/day, acceptance rate, completed/unknown coverage, net expectancy per trade and per day, profit factor, net win rate, drawdown/tail loss, turnover, holding-time percentiles, MFE captured, stale rejects, and latency/cost sensitivity. Compare at identical approved capital/risk constraints, not only per-signal returns. Estimate uncertainty with day/episode blocks rather than treating correlated ticks as independent trades.

Promotion requires zero ownership-policy violations or duplicate mutations in deterministic restart/ACK/race tests; reproducible out-of-sample positive net expectancy and improvement over baseline with a pre-registered uncertainty criterion; drawdown within approved limits; and acceptable prospective shadow data/protection coverage. Set sample-size/power and coverage requirements before collection, not after seeing a favorable result. If those requirements fail, remain SHADOW. Higher opportunity frequency may reduce win rate or net expectancy; neither most signals nor most profitable trades is guaranteed.

## Evidence And Validation

Existing golden-parity, anti-lookahead, outcome, storage and durable recovery fixtures were executed. They establish deterministic mechanics, not economic superiority. `src/tooling/safety-replay.ts:1-8` explicitly describes synthetic mechanics; it is not a validated multi-symbol profitability backtest. No complete latency-aware, paired historical dataset was established in this review, and the proposed candidates are not implemented. Therefore baseline-versus-proposal net expectancy, training scores and untouched-test scores are **not measured**, not zero and not inferred from passing unit tests.

Final verification: **48 files / 901 tests passed** across position, execution, ownership, Micro, Momentum and TradingService. This follow-up adds 11 cases beyond the incoming audit patch: both strategies' async ownership handoffs, incomplete/verified startup identity, external/unknown startup paths, pending evidence after an await, and verified-but-metrics-excluded real startup. Positive manual tests assert the exact ROE overrides; existing integration tests also verify actual missing-bracket placement and preservation of existing brackets. TypeScript passed with `npm run build -- --outDir /tmp/opencode/ownership-review-build`; production `dist` was not overwritten. `git diff --check` passed.
