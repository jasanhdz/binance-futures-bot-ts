# Micro Burst Opportunity Model — Implementation Itinerary (B → Z)

**Branch:** `feature/micro-opportunity-model-v1`  
**Base:** `work/micro-burst-rider-v1-20260826`  
**Strategy:** `MICRO_BURST_V1`  
**Rule:** A stage is marked `DONE` only when its deliverables exist and its gate has evidence.  
**Safety:** No stage may silently widen LIVE authority. ML starts observational/shadow-only. Exchange hard invalidation and fail-closed controls remain independent.

## Status legend

- `DONE` — implementation + required evidence completed.
- `IN_PROGRESS` — currently being implemented.
- `BLOCKED` — dependency/evidence unavailable.
- `TODO` — not started.

## A — Stable baseline

**Status:** `DONE` (pre-existing project baseline; explicitly supplied by owner).  
**Priority:** P0.  
**Scope:** Preserve the current stable Micro Burst implementation as the comparison baseline. This branch is additive and must not mutate the stable branch.

---

## B — Scientific experiment contract / preregistration

**Status:** `DONE`  
**Priority:** P0  
**Goal:** Define the hypothesis, labels, splits, costs, metrics, decision gates, and sealed-holdout rules before model fitting.

**Deliverables**
- `docs/micro-burst/opportunity/MICRO_OPPORTUNITY_PREREGISTRATION_V1.md`
- Explicit primary/secondary hypotheses.
- Fixed horizons: 10 s, 30 s, 60 s.
- Fixed cost scenarios compatible with existing Micro Burst outcome semantics.
- Strict temporal TRAIN → VALIDATION → sealed HOLDOUT.
- Acceptance/rejection rules fixed before opening HOLDOUT.

**Gate evidence**
- Preregistration frozen on 2026-09-03 before model fitting.
- Primary economic gate fixed at +2.0 paired net bps/candidate under `cost_14`, with positive blocked-bootstrap lower CI bound and stability/stress gates.
- HOLDOUT remains sealed until candidate/model/schema/policy freeze.

---

## C — Split Micro state into Slow State and Fast State

**Status:** `DONE`  
**Priority:** P0  
**Goal:** Keep structural/candle context slow while exposing event-driven market context independently.

**Slow State**
- Closed 1m/3m/5m candles.
- Support/resistance.
- Micro regime.
- Structural position/room/risk geometry.
- BTC slow context.

**Fast State**
- Last trade/live reference price.
- Best bid/ask + spread.
- Returns/velocity/acceleration over sub-minute windows.
- Taker-flow imbalance/intensity.
- Book imbalance/slope.
- Sweep/absorption state.
- Per-source timestamps/freshness/data quality.

**Gate**
- Existing entry/exit behaviour remains unchanged by default.
- Fast state has no exchange mutation authority.

---

## D — Implement `MicroBurstFastMarketState`

**Status:** `DONE`  
**Priority:** P0  
**Goal:** Maintain a deterministic per-symbol in-memory state from shared market data.

**Required features (V1)**
- Last price and timestamp.
- Returns: 250 ms, 1 s, 3 s, 5 s, 10 s when coverage exists.
- Price velocity and acceleration.
- Trade count/intensity.
- Buy/sell taker volume and signed taker imbalance.
- Best bid/ask/mid/spread bps.
- Signed book imbalance and imbalance slope.
- Temporal sweep/absorption flags.
- Gap/freshness/coverage diagnostics.

**Gate**
- No REST call in the fast-state update/read path.
- Deterministic unit tests for LONG/SHORT-neutral market math and stale/gap handling.

---

## E — Add high-frequency research sampling independent of the 5 s strategy loop

**Status:** `IN_PROGRESS`
**Priority:** P0  
**Goal:** Collect causal opportunity snapshots without changing the existing LIVE evaluation cadence.

**V1 cadence**
- Research sampler: 1 s per enabled symbol.
- Later experiment: 250 ms/event-driven only after storage/CPU evidence.

**Gate**
- Sampling is observational only.
- Backpressure/storage failure must not block trading runtime.

---

## F — Freeze `OpportunityFeatureVectorV1`

**Status:** `DONE`  
**Priority:** P0  
**Goal:** Define the exact causal feature contract shared by offline training and TypeScript inference.

**Feature families**
- Fast price dynamics.
- Trade/taker flow.
- Book/microstructure.
- Structural room/risk.
- Momentum/regime.
- BTC context.
- Data-quality/freshness metadata.
- Original Micro decision/reason as research metadata only (not necessarily a model feature).

**Gate**
- Every feature documents unit, timestamp semantics, missing-data semantics, and causal source.
- Feature-schema hash/version is persisted with every sample and model artifact.

---

## G — Capture continuous market states, not only Micro entries

**Status:** `IN_PROGRESS`
**Priority:** P0  
**Goal:** Remove entry-selection bias from the predictive dataset.

**Required populations**
- `ENTRY_INTENT` states.
- `NO_TRADE` states.
- LONG-candidate and SHORT-candidate counterfactual orientation.
- Neutral/unclear states when data quality is sufficient.

**Gate**
- Dataset generation does not depend on an executed or shadow trade existing.

---

## H — Generate counterfactual LONG/SHORT MFE/MAE labels

**Status:** `DONE`  
**Priority:** P0  
**Goal:** Label every valid T0 state in both orientations.

**Horizons**
- 10 s.
- 30 s.
- 60 s.

**Labels**
- `longMfeBps`, `longMaeBps`, `shortMfeBps`, `shortMaeBps`.
- `finalReturnBps` per orientation.
- `timeToMfeMs`, `timeToMaeMs`.
- Coverage/gap validity flags.

**Gate**
- Only post-T0 observations contribute to labels.
- Invalid/gapped horizons are null/invalid, never zero-filled.

---

## I — Add economic/net opportunity labels

**Status:** `DONE`  
**Priority:** P0  
**Goal:** Train/evaluate on exploitable movement rather than gross movement alone.

**Cost scenarios**
- Existing Micro Burst scenarios: 0, 10, 14, 20, 30 bps.

**Derived labels**
- Net favorable opportunity after cost.
- Net-positive flag.
- MFE/MAE asymmetry.
- Target-before-adverse/barrier variants where preregistered.

**Gate**
- Cost definition identical across baseline, model candidate, and validation reports.

---

## J — Leakage/causality audit

**Status:** `IN_PROGRESS`
**Priority:** P0  
**Goal:** Prove features are available at T0 and labels are strictly future-only.

**Automated checks**
- Closed candles only.
- No future S/R availability.
- No post-T0 book/trade feature.
- Labels excluded from feature vector.
- Episode/time groups cannot straddle TRAIN/VALIDATION/HOLDOUT.

**Gate:** Any leakage failure blocks training.

**Evidence (2026-09-04):** Formal audit over 3,952 labeled live samples found zero future-field, schema, duplicate, or label-in-feature violations.

---

## K — Dataset quality audit

**Status:** `IN_PROGRESS`
**Priority:** P0  
**Goal:** Quantify whether the archive can support model claims.

**Report**
- Coverage by symbol/date/regime/side orientation.
- Missing/stale/gapped market data.
- Sample autocorrelation/duplication pressure.
- Outcome distributions and tails.

**Gate:** Invalid samples are explicitly excluded with reason codes.

**Evidence (2026-09-04):** Formal report over 3,952 labeled samples found 0 governance exclusions and 0 duplicate pressure, but quality remains insufficient for training: 149 stale/book-gap rows, 2 aggTrade-gap rows, and 11,133 missing feature values.

---

## L — Version and freeze the official dataset

**Status:** `BLOCKED — requires sufficient prospective labeled data`
**Priority:** P0  
**Goal:** Produce a reproducible immutable dataset manifest.

**Manifest fields**
- Dataset/schema versions.
- Source code SHA/config hash.
- Date ranges/symbols.
- Row counts and exclusions.
- Feature list/hash.
- Label semantics/cost scenarios.
- TRAIN/VALIDATION/HOLDOUT boundaries.

---

## M — Non-ML baselines

**Status:** `IN_PROGRESS`
**Priority:** P0  
**Goal:** Establish how much improvement simple deterministic rules can achieve.

**Candidates**
- Existing Micro gates.
- Momentum/room/flow/book thresholds.
- Simple linear/logistic score.

**Gate:** ML must beat both current Micro and appropriate simple baselines out-of-sample.

---

## N — Train Opportunity Model V1 offline in Python

**Status:** `IN_PROGRESS`
**Priority:** P1  
**Goal:** Fit interpretable tabular baselines before sequential/deep models.

**Initial models**
- LightGBM primary.
- Logistic/linear baseline.
- Optional CatBoost comparison.

**Primary predictions**
- Expected MFE.
- Expected MAE.
- Probability of net-positive opportunity.

**Rule:** Training/research stays Python; production inference is not a Python HTTP dependency.

---

## O — Generalization/stability evaluation

**Status:** `IN_PROGRESS`
**Priority:** P0  
**Goal:** Require stable performance rather than one pooled mean.

**Slices**
- Date/walk-forward.
- Symbol.
- LONG/SHORT orientation.
- Regime/volatility.
- 14 bps base cost and 20/30 bps stress.

---

## P — Define Opportunity Score/policy inputs

**Status:** `IN_PROGRESS`
**Priority:** P1  
**Goal:** Convert calibrated predictions into a small auditable contract.

**Runtime output V1**
- `expectedMfeBps`.
- `expectedMaeBps`.
- `probabilityNetPositive`.
- `opportunityScore`.
- Model/schema version + timestamps + inference latency.

---

## Q — Integrate an entry gate without changing direction authority

**Status:** `IN_PROGRESS`
**Priority:** P1  
**Goal:** Micro keeps LONG/SHORT authority; Opportunity V1 may only allow/reject an otherwise valid entry.

**V1 actions**
- `ALLOW`.
- `REJECT`.

**Not allowed in V1**
- Flip LONG ↔ SHORT.
- Increase leverage.
- Increase position fraction.
- Create an entry when Micro says `NO_TRADE`.

---

## R — Historical Black Box A/B replay

**Status:** `BLOCKED — requires dataset and model evidence`
**Priority:** P0  
**Goal:** Compare the exact same candidate population.

**A:** stable Micro baseline.  
**B:** stable Micro + Opportunity Gate.

**Metrics**
- Net bps/trade and total net bps.
- Mean/median and bootstrap CI.
- Profit factor/win rate.
- MAE/tail loss/drawdown proxy.
- MFE capture and rejected-winner regret.
- Avoided losers.
- Trade count/turnover.

---

## S — Rejection/error analysis

**Status:** `BLOCKED — requires dataset and model evidence`
**Priority:** P0  
**Goal:** Understand *why* the gate improves/degrades outcomes.

**Required cohorts**
- Winners kept.
- Winners rejected.
- Losers kept.
- Losers rejected.
- Symbol/regime/side stability.

---

## T — Freeze candidate and open VALIDATION once

**Status:** `BLOCKED — requires validated candidate evidence`
**Priority:** P0  
**Goal:** Prevent iterative overfitting to validation.

**Gate:** Model artifact, feature schema, thresholds, cost semantics, latency assumption, and integration policy are frozen before VALIDATION scoring.

---

## U — Local TypeScript inference runtime

**Status:** `IN_PROGRESS`
**Priority:** P1  
**Goal:** Keep inference inside the trading process; Python remains offline-only.

**Requirements**
- Model loaded once and held in memory.
- Deterministic feature ordering/schema check.
- No HTTP inference dependency.
- Fail-closed/stale policy explicit.
- Prediction cannot block exchange safety controls.

---

## V — Runtime latency/resource benchmark

**Status:** `IN_PROGRESS`
**Priority:** P0  
**Goal:** Measure rather than assume latency benefit.

**Metrics**
- Feature build p50/p95/p99.
- Inference p50/p95/p99.
- Total decision overhead.
- CPU/memory at 1, 5, 11 symbols.
- Event-loop lag.

---

## W — Real-time shadow dual-run

**Status:** `IN_PROGRESS`
**Priority:** P0  
**Goal:** Observe model decisions prospectively with zero execution authority.

**Persist**
- Stable Micro decision.
- Opportunity prediction.
- Hypothetical gated decision.
- Prediction/outcome linkage.

---

## X — Prospective shadow A/B validation

**Status:** `BLOCKED — requires prospective samples and frozen model`
**Priority:** P0  
**Goal:** Confirm historical gains survive fresh data, real timing, and real data quality.

**Gate:** Predefined minimum sample and economic/stability requirements must pass before LIVE authority.

---

## Y — Minimal fail-closed LIVE canary

**Status:** `BLOCKED — requires X gate`
**Priority:** P0  
**Goal:** Tiny controlled deployment only after X passes.

**Safety**
- Explicit opt-in.
- Bounded symbols/size.
- Model/schema/freshness failure cannot produce an unvalidated prediction.
- Hard stop/invalidation/emergency controls stay independent.
- Rollback to stable Micro is immediate and versioned.

---

## Z — Production promotion + Opportunity Exit V2 research

**Status:** `BLOCKED — requires LIVE canary evidence`
**Priority:** P1  
**Goal:** Promote only after LIVE evidence, then separately research remaining opportunity for exits.

## Infrastructure Progress Log

- **2026-09-04:** M/N/O/U/V/W infrastructure prepared without changing LIVE authority. Added deterministic offline JSONL loading and baseline/evaluation scaffolding, optional Logistic Regression/LightGBM artifact writers with metadata hashes, local in-memory inference with schema/hash and stale fail-closed checks, percentile benchmark summaries, and a shadow dual-run record explicitly marked `STABLE_MICRO_ONLY`.
- **2026-09-04:** P/Q contract tests cover schema drift, stale/invalid model output, `NO_TRADE` rejection, probability rejection, and preservation of Micro LONG/SHORT direction.
- **Evidence status:** M, N, O, P, Q, U, V, W remain `IN_PROGRESS`; no stage is marked `DONE` because prospective labeled samples and measured runtime evidence are still required. L, R, S, T, X, Y, Z remain blocked.
- **Correction pending rollout (2026-09-04):** Parallel per-symbol evaluation prevents slow candle reads from starving `latestSlowState`; sampler tick duration p50/p95/p99 telemetry was added. PM2 is intentionally still on the prior build, so post-change coverage/overhead cannot yet be claimed.

**Entry V1 promotion**
- Expand symbols progressively.
- Freeze production model/config.
- Model/version telemetry and rollback.
- Retraining requires a new version and validation cycle.

**Exit V2 (separate experiment)**
- Predict remaining MFE/MAE/continuation while a Micro position is open.
- Compare against `EXPECTED_CONTINUATION_V2` on identical positions.
- Do not conflate entry-model improvements with exit-model improvements.

---

# Global non-negotiable gates

1. **Causality:** no feature may see the future.
2. **Identical comparison population:** A/B metrics use identical candidate timestamps and definitions.
3. **Economic evaluation:** base costs + stressed costs are always reported.
4. **No hidden LIVE authority:** observational stages cannot mutate Binance.
5. **Fail closed:** stale/gapped/schema-invalid/model-invalid inputs cannot create an unvalidated entry.
6. **Hard risk remains independent:** ML never removes structural invalidation/emergency protection.
7. **No leverage escalation in V1:** Opportunity Gate can only preserve or reduce authority.
8. **Holdout stays sealed:** only opened after candidate freeze.
9. **Version everything:** code SHA, config, dataset, schema, model, policy.
10. **Evidence before complexity:** deep/sequential models are justified only if tabular baselines leave a demonstrated gap.

# Progress log

- 2026-09-03 — Branch created from stable Micro Burst branch.
- 2026-09-03 — A acknowledged as completed pre-existing baseline.
- 2026-09-03 — B completed: preregistration frozen before model fitting.
- 2026-09-03 — C started: slow/fast market-state separation.
- 2026-09-04 — `322de68`: Fast State test corrected to exercise an actually missing book; continuous sampler hardened against input/sink failures and re-entry, and now records both counterfactual orientations plus population metadata. Build and focused Micro Opportunity/Fast State tests passed (12/12).
- 2026-09-04 — `d55c95c`: Causality audit now rejects future closed-candle/state watermarks and label-shaped feature fields; quality report exposes validity, exclusions, coverage, populations, missingness, gaps, duplication pressure, and label distributions. Focused tests passed (14/14 at commit time).
- 2026-09-04 — Real archive inspection: `m3_2_5_final/20260827T193200Z/research.sqlite` has 24 market-data segments but 0 signals, 0 outcomes, and no continuous Opportunity samples. No causal TRAIN/VALIDATION/HOLDOUT can be built; dataset-dependent stages remain blocked/in progress and HOLDOUT stays sealed.
- 2026-09-04 — `a853352`: connected the observational 1 s sampler to the runtime's shared aggTrade/order-book planes, persisted idempotent samples with feature schema/hash and provenance metadata, and added deferred 10/30/60 s label persistence after future watermark coverage. Build and focused runtime/storage/research tests passed (76/76). A real soak was not claimed: the available archive still has 0 Opportunity samples, so E/G remain `IN_PROGRESS` and J/K cannot pass their real-data gates.
- 2026-09-04 — LIVE verification: PM2 process `01-Trading-Bot` is online with `liveExecution=true`, 11 symbols, and normal Micro activity; it was not restarted or modified. Its loaded artifact predates the sampler integration and the tracked LIVE config had archive/prospective collection disabled. Active SQLite `data/micro-burst/micro_burst_research.sqlite` has 74 market-data segments but no `micro_opportunity_samples` table, so samples/labels are 0. Archive and prospective collection are now enabled in configuration for the next authorized rollout; no E/G/J/K DONE claim is made.
