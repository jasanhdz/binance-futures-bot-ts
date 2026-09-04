# Micro Burst Opportunity Model V1 — Preregistration

**Status:** FROZEN_FOR_IMPLEMENTATION  
**Date:** 2026-09-03  
**Branch:** `feature/micro-opportunity-model-v1`  
**Baseline strategy:** stable `MICRO_BURST_V1` inherited from `work/micro-burst-rider-v1-20260826`  
**Purpose:** Determine whether a causal local Opportunity Model can improve the economics of Micro Burst entries without replacing Micro's direction authority or weakening Aegis/risk controls.

## 1. Primary research question

For candidate states evaluated by the stable Micro Burst entry policy, can a model using only information available at decision time identify entries with enough remaining favorable excursion relative to adverse excursion and trading costs to improve net results out-of-sample?

The model is **not** authorized in V1 to:
- create a trade when stable Micro says `NO_TRADE`;
- flip LONG to SHORT or SHORT to LONG;
- increase leverage or position fraction;
- bypass Aegis/risk/structural invalidation;
- control exits.

V1 authority, if eventually promoted, is only `ALLOW` or `REJECT` for an otherwise valid Micro entry.

## 2. Hypotheses

### H1 — Primary economic hypothesis

On an identical stable-Micro candidate population, `Micro + Opportunity Gate` improves paired net economic outcome versus stable Micro under the 14 bps base-cost scenario.

### H2 — Opportunity-estimation hypothesis

Causal market-state features contain out-of-sample information about future favorable and adverse excursions at 10 s, 30 s, and 60 s horizons.

### H3 — Robustness hypothesis

Any improvement is not concentrated in one symbol, one temporal slice, one orientation, or one cost assumption.

## 3. Unit conventions

- Price return: decimal internally where inherited code requires it.
- Reported excursion/return: true basis points (`10 bps = 0.10%`).
- Time: epoch milliseconds.
- MFE/MAE: always side-aware and non-negative magnitudes.
- A negative net result means loss after the declared cost scenario.

## 4. Observation population

Two populations are deliberately separated.

### 4.1 Continuous research population

Valid causal market states sampled independently of the stable Micro entry decision. This population is used for learning future market opportunity without selection bias.

It includes:
- states where stable Micro would emit `ENTRY_INTENT`;
- states where stable Micro would emit `NO_TRADE`;
- valid neutral/unclear states;
- both counterfactual LONG and SHORT outcome labels where sufficient future data exists.

### 4.2 Stable-Micro candidate population

Exact timestamps where the frozen stable Micro policy emits a unique, non-duplicate `ENTRY_INTENT` with valid data quality. This population is the only population used for the primary A/B policy claim.

A and B must use the **same exact candidate IDs/timestamps**:
- A = stable Micro accepts every stable-Micro candidate subject to the frozen downstream baseline rules.
- B = the same candidate population, with Opportunity V1 allowed only to reject.

Changing the candidate population between A and B invalidates the experiment.

## 5. Sampling and horizon definitions

### Research sampling cadence V1

- 1,000 ms per enabled symbol.
- Sampling is observational and independent of the existing 5 s strategy evaluation cadence.
- Higher-frequency/event-driven sampling is a future experiment and not part of V1 claims.

### Fixed horizons

- 10,000 ms
- 30,000 ms
- 60,000 ms

No horizon may be added to the primary V1 model after VALIDATION is inspected.

## 6. Counterfactual label definitions

For each valid T0 state and each horizon H, using only qualified post-T0 trades/prices through T0+H:

For LONG:
- `longMfeBps` = maximum positive side-aware excursion from T0 entry/reference price.
- `longMaeBps` = maximum adverse excursion below T0 reference price.
- `longFinalReturnBps` = side-aware return at H.

For SHORT:
- `shortMfeBps` = maximum favorable downward excursion.
- `shortMaeBps` = maximum adverse upward excursion.
- `shortFinalReturnBps` = side-aware return at H.

Also record:
- `timeToMfeMs`;
- `timeToMaeMs`;
- price/trade sample count;
- gap/coverage validity.

A horizon with insufficient/gapped future evidence is `INVALID/NULL`, never zero-filled.

## 7. Economic cost scenarios

Reuse the existing Micro Burst cost semantics exactly:

| Label | Total cost assumption |
|---|---:|
| `cost_0` | 0 bps |
| `cost_10` | 10 bps |
| `cost_14` | 14 bps |
| `cost_20` | 20 bps |
| `cost_30` | 30 bps |

`cost_14` is the primary economic scenario. `cost_20` and `cost_30` are mandatory stress reports.

The same cost definition must be applied to baseline and candidate policy. Cost semantics may not differ by outcome/model.

## 8. Feature causality contract

Every model feature must be available no later than T0. Each feature must declare:
- source;
- unit;
- observation/event timestamp;
- local receive timestamp where applicable;
- freshness semantics;
- missing-data semantics;
- feature schema version.

Forbidden:
- future candle values;
- S/R not causally available at T0;
- post-T0 trades/depth in features;
- outcome/label-derived features;
- normalization fitted using VALIDATION/HOLDOUT future data.

## 9. Dataset split protocol

Use chronological contiguous splits after ordering by event time.

Initial fixed proportions:
- TRAIN: first 60% of eligible chronological observations.
- VALIDATION: next 20%.
- HOLDOUT: final 20%, sealed.

### Purge/embargo

At each split boundary, purge observations whose maximum 60 s labeling horizon overlaps the adjacent split. Minimum embargo = 60,000 ms; implementation may use a larger conservative embargo but must record it in the dataset manifest before scoring.

Samples belonging to the same deduplicated episode/state cluster may not straddle splits.

## 10. Model family V1

Primary tabular model: LightGBM trained offline in Python.

Required simple baselines:
- deterministic stable-Micro geometry/continuation rules;
- logistic/linear baseline using the same causal feature contract.

Optional CatBoost comparison is exploratory until separately frozen.

Deep/sequential models are explicitly out of scope for the primary V1 claim.

## 11. Model outputs

The frozen runtime contract may contain:
- `expectedMfeBps`;
- `expectedMaeBps`;
- `probabilityNetPositive`;
- `opportunityScore`;
- horizon/model/schema metadata.

The exact policy threshold must be selected on TRAIN and frozen before final VALIDATION scoring.

## 12. Primary A/B metrics

Computed on the exact stable-Micro candidate population:

1. Paired delta net bps per baseline candidate at `cost_14`.
2. Total net bps at `cost_14`.
3. Net bps per accepted trade.
4. Mean and median accepted-trade net bps.
5. Profit factor.
6. Win rate.
7. Trade acceptance/rejection rate.
8. Rejected-winner regret.
9. Avoided-loser benefit.
10. MAE and lower-tail loss distribution.
11. Symbol/orientation/regime/time-slice stability.
12. Mandatory `cost_20` and `cost_30` stress results.

## 13. Statistical protocol

Primary comparison is paired by stable-Micro candidate ID/timestamp.

- Bootstrap 95% confidence interval for paired delta net bps per candidate.
- Bootstrap resampling must respect temporal dependence via blocked/episode-aware resampling where feasible; iid row bootstrap alone is not sufficient for the final claim.
- Report point estimate and interval; p-values are secondary.

## 14. Acceptance gates before HOLDOUT

A candidate may be frozen for HOLDOUT only if VALIDATION simultaneously satisfies:

1. `cost_14` paired delta net bps per baseline candidate >= **+2.0 bps**.
2. 95% bootstrap CI lower bound for paired delta at `cost_14` is **> 0**.
3. Total candidate-policy net bps at `cost_14` is positive and exceeds baseline total net bps.
4. Opportunity Gate retains at least **25%** and at most **90%** of frozen stable-Micro candidates. This prevents trivial `reject almost everything` and `change almost nothing` solutions.
5. Lower-tail risk (10th percentile accepted-trade net return or an equivalent preregistered tail statistic) must not deteriorate by more than **1.0 bps** versus baseline.
6. The sign of paired improvement must be positive in at least **60% of sufficiently populated symbol slices** and at least **60% of sufficiently populated chronological validation slices**.
7. `cost_20` paired improvement must remain positive.
8. No leakage, schema, gap, or provenance gate is failing.

A slice is `sufficiently populated` only if it contains at least 30 baseline candidates; smaller slices are reported but do not count toward the 60% stability gate.

The +2.0 bps practical-significance gate is intentionally much larger than previously observed sub-bps experimental noise and cannot be reduced after VALIDATION is inspected.

## 15. HOLDOUT protocol

HOLDOUT remains sealed until:
- feature schema frozen;
- model artifact frozen;
- threshold/policy frozen;
- model hash recorded;
- dataset manifest frozen;
- validation report completed;
- all acceptance gates above pass.

HOLDOUT is opened once for the V1 candidate.

Primary success on HOLDOUT requires:
- paired delta at `cost_14` > 0;
- practical improvement >= +2.0 bps/candidate;
- 95% blocked-bootstrap CI lower bound > 0;
- `cost_20` improvement remains positive;
- no material tail-risk regression;
- no governance/causality failure.

Failure means `V1_NO_CONFIRMED_EDGE`. A V2 requires a new frozen candidate; HOLDOUT is not reused as TRAIN.

## 16. Runtime integration constraints

If offline evidence eventually passes:
- training remains Python/offline;
- production inference is local to TypeScript/in-process;
- no Python HTTP inference dependency in the Micro hot path;
- model/schema mismatch fails closed;
- stale or invalid feature context cannot create an ML-approved entry;
- stable hard invalidation/emergency protection remains independent;
- Opportunity V1 never increases leverage/size.

## 17. Exit-policy isolation

`EXPECTED_CONTINUATION_V2` remains unchanged during Opportunity Entry V1 evaluation.

Entry-model and exit-model experiments must use separately versioned policies and reports. No claim that Opportunity Entry V1 improves exits is allowed.

## 18. Required reports

Before any LIVE authority:
- dataset causality audit;
- dataset quality report;
- baseline report;
- TRAIN report;
- frozen VALIDATION report;
- model/feature manifest;
- TypeScript parity report;
- latency/resource benchmark;
- prospective shadow A/B report;
- if gates pass, separately preregistered LIVE canary plan.

## 19. Governance result vocabulary

Allowed final labels:
- `OPPORTUNITY_V1_EDGE_CONFIRMED`
- `OPPORTUNITY_V1_NO_CONFIRMED_EDGE`
- `OPPORTUNITY_V1_INVALID_EXPERIMENT`
- `OPPORTUNITY_V1_BLOCKED_BY_DATA`

No weaker wording may be used to promote a failed gate to LIVE.
