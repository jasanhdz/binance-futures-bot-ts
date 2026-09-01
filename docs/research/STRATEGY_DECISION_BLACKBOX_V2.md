# Strategy Decision Black Box V2

**Status:** OPERATIONAL OBSERVABILITY — NO RUNTIME AUTHORITY
**Dependency:** Shared Market Data V1 is the causal market-snapshot contract consumed by Black Box V2.
**Role:** tiered observational evidence only; no feedback into strategy decisions.

## 1. Research objective

Create a causal, reproducible record of what the market looked like and what each strategy knew when it evaluated or produced a decision, so future research can determine which observable conditions distinguish economically useful entries from poor entries.

The black box is not a trading strategy and is not an entry gate.

Runtime information flow is strictly:

```text
market state + strategy evaluation
              |
              v
       black-box evidence
              |
              v
       offline research
```

There is no arrow from the black box back into Aegis, Momentum, Micro Burst, risk, sizing,
execution, or LIVE authority in V2.

## 2. Why shared market data comes first

Order book, AggTrades, candles, quotes, and benchmark state describe the same market regardless of which strategy is evaluating it. Capturing separate strategy-owned versions would:

- duplicate feeds and storage;
- create timestamp inconsistencies;
- make cross-strategy comparisons unreliable;
- make future order-book research for Aegis/Momentum harder;
- couple research plumbing to one strategy.

The black box therefore references a shared causal `MarketSnapshot` plus a separate strategy-specific decision snapshot.

## 3. Core record model

### 3.1 MarketSnapshot

A versioned immutable representation of market facts causally available at capture time. Shared
Market Data continues to produce `MarketSnapshotV1`; Black Box persists it only inside its V2
storage envelope.

Conceptual fields:

```ts
interface MarketSnapshotEvidenceV2 {
  schemaVersion: 2;
  schema: 'STRATEGY_MARKET_SNAPSHOT_EVIDENCE_V2';
  snapshotId: string;
  contentHash: string;
  recordedAtMs: number;
  marketSnapshot: MarketSnapshotV1;
  provenance: {
    marketSnapshotSchemaVersion: 1;
    storagePolicy: 'DEDUPLICATED_ROTATING_JSONL_V2';
  };
}
```

The actual schema must be compact and explicitly versioned. Do not persist entire in-memory objects merely because they are convenient.

### 3.2 StrategyDecisionSnapshot

A strategy-owned record linked to a shared market snapshot.

Conceptual fields:

```ts
interface StrategyDecisionEvidenceV2 {
  schemaVersion: 2;
  decisionId: string;
  marketSnapshotId: string;
  marketSnapshotStored: boolean;
  marketSnapshotContentHash: string;
  observedMarketSnapshotId?: string;
  evidenceLevel: 'COMPACT' | 'FULL_REPLAY';
  symbol: string;
  evaluatedAtReceivedMs: number;
  strategyTimestampMs: number;
  strategy: StrategyIdentity;
  decision: 'ENTRY_INTENT' | 'NO_TRADE';
  diagnostics: Record<string, unknown>;
  provenance: {
    schema: 'STRATEGY_DECISION_BLACKBOX_V2';
    schemaVersion: 2;
    marketSnapshotSchemaVersion: 1;
    causalClock: 'LOCAL_RECEIVE_TIME';
    storagePolicy: 'TIERED_DEDUPLICATED_ROTATING_JSONL_V2';
  };
}
```

Each strategy decides which internal features are safe and meaningful to persist. Full replay is
reserved for candidates, entry intents and evaluation failures; routine decisions use compact
evidence. Shared market facts are referenced by content hash and snapshot id instead of copied
into strategy-specific fields.

### 3.3 Outcome

Outcome is joined later. It must not exist in the decision-time feature object.

Potential outcome families:

1. **Managed paper outcome** — actual `ShadowTradingEngine` lifecycle for an executed SHADOW position.
2. **Neutral fixed-horizon outcome** — what price path did after a candidate, independent of the strategy's exit manager.
3. **Opportunity/path outcome** — MFE, MAE, barrier ordering, residual move, or other preregistered labels.

These families must remain distinguishable. A fixed 5-minute counterfactual is not the same thing as the strategy's managed paper PnL.

## 4. Candidate population

The learning system must not retain only winning or executed entries.

Where technically and causally scorable, preserve:

- actionable entries;
- SKIP/NO_TRADE candidates that reached the defined research-candidate boundary;
- same-strategy/same-symbol suppressed candidates;
- executable-quote unavailable candidates;
- candidates rejected by named gates;
- later outcome status: scored / unscorable / incomplete.

The exact candidate boundary must be preregistered before using a cohort for modeling. Logging every 5-second generic evaluation may create excessive duplicates and false sample size, while logging only executed trades creates selection bias.

## 5. Episode independence

Raw snapshots and statistical samples are different concepts.

The system may collect many nearby decision snapshots for observability, but offline dataset building must define an `episodeId` or equivalent independent-opportunity grouping so repeated evaluations of the same market move do not masquerade as independent evidence.

Episode rules must be defined before model evaluation and must not be tuned to improve a result.

Potential grouping inputs include:

- strategy + symbol;
- direction;
- temporal separation;
- structural level/opportunity identity;
- existing signal identity where appropriate.

No single universal rule is declared here; the dataset preregistration must choose one and freeze it.

## 6. Causal feature boundary

A feature is valid only if it was available at or before the decision's local receive-time boundary.

Never use as a feature:

- future candles;
- a book update received after decision time;
- future AggTrades;
- final trade outcome;
- post-entry MFE/MAE;
- exit reason;
- labels derived from the future;
- model calibration using validation/holdout outcomes.

Exchange timestamps alone do not prove causal availability. Local receive time is required for online causality.

## 7. Shared market features to consider recording

Initial neutral candidate set may include, with versioned definitions:

### Quote/liquidity

- bid;
- ask;
- spread bps;
- quote age/quality.

### Order book

- top-N signed imbalance;
- top-N bid/ask quantity;
- depth within fixed bps bands if implemented causally;
- best bid/ask size;
- short-window changes in neutral imbalance/depth if available from the shared state;
- book age/health;
- gap/resync diagnostics.

### AggTrades

- buyer-initiated volume;
- seller-initiated volume;
- net taker volume;
- trade count/rate;
- window coverage;
- gap-free/complete flags;
- optionally neutral deltas/acceleration after definitions are frozen.

### Candles

- causal returns over fixed windows;
- range/body/wick facts;
- volume;
- ATR/volatility only with frozen definition;
- data freshness/gaps.

### Benchmark

- BTC/benchmark returns or other raw neutral facts;
- source quality.

The black box may observe these for Aegis or Momentum even when those strategies do not currently use them to decide.

## 8. Strategy-specific feature examples

### Micro Burst

Potential records:

- burst/momentum outputs;
- continuation diagnostics;
- room-to-obstacle;
- extension;
- Micro Burst-specific book-pressure interpretation;
- BTC conflict interpretation;
- structural stop/destination;
- gate decisions.

### Aegis

Potential records:

- EQM;
- TRRM;
- QMAE;
- expected return;
- strategy score/calibration;
- current guard results;
- regime/context features already known at decision time.

Order book/AggTrades remain observational shared data initially; they are not silently added to the Aegis decision vector.

### Momentum

Potential records:

- current momentum score/features;
- persistence/continuation diagnostics;
- strategy gates;
- price/candle context already consumed.

Again, book/AggTrades may be recorded observationally without becoming decision dependencies.

## 9. Outcome design for future learning

The purpose is not simply `winner=1, loser=0`.

Useful preregistered targets may include:

- `gross_bps`;
- `net_10_bps`;
- `net_14_bps`;
- `net_20_bps`;
- `net_30_bps`;
- MFE at fixed horizons;
- MAE at fixed horizons;
- MFE before MAE/barrier ordering;
- managed trade duration;
- exit reason;
- probability that residual move after detection covers realistic cost.

A future model should be evaluated economically after costs. Correct direction with insufficient residual movement is not sufficient edge.

## 10. Fixed-horizon outcomes for non-executed candidates

To learn from SKIP/suppressed/unfilled candidates, an offline resolver may calculate preregistered horizons such as:

- +15 seconds;
- +30 seconds;
- +60 seconds;
- +180 seconds;
- +300 seconds.

The exact official horizons must be frozen in the cohort specification before analysis. Do not inspect results and then retain only the horizon that looks best.

Counterfactual executable economics require honest bid/ask or a documented approximation. If the archive cannot support an honest fill, mark the outcome unscorable rather than fabricate precision.

## 11. Storage model

Prefer append-only/versioned evidence.

A possible structure:

```text
data/strategy-blackbox/
  market-snapshots/
  strategy-decisions/
  outcome-links/
  manifests/
```

or a versioned database with equivalent logical separation.

Existing strategy logs remain intact. Do not destructively migrate Aegis, Momentum, or Micro Burst historical evidence merely to fit the black-box schema.

## 12. Runtime performance boundary

The online collector should do the minimum required to preserve information that cannot be reconstructed later.

Online responsibilities:

- capture/link causal market snapshot;
- capture strategy decision snapshot;
- enqueue/write durable evidence with bounded resources;
- expose collection health.

Offline responsibilities:

- outcome resolution;
- joins;
- dataset construction;
- dedup/episodes;
- statistical analysis;
- plots;
- model training;
- cross-validation;
- bootstrap;
- feature importance;
- negative controls.

No model training runs inside `01-Trading-Bot`.

## 13. Failure semantics

V2 black-box collection is observational. A storage failure should be visible through
health/telemetry but must not silently alter a strategy's decision.

For a future official evidence cohort, governance may choose to declare a period invalid if collection health is incomplete. That is different from blocking a LIVE decision.

Required metrics should include:

- snapshots attempted/written/failed;
- strategy decisions attempted/written/failed;
- queue depth/overflow if asynchronous;
- missing capabilities by source;
- causal/quality rejection counts;
- orphan decision/snapshot/outcome links.

## 14. Cross-strategy comparison

The shared market snapshot makes comparisons possible without merging strategy ownership.

Example:

```text
MarketSnapshot ETH @ t0

AEGIS      -> SHORT
MOMENTUM   -> SKIP
MICROBURST -> SHORT
```

Later research can ask:

- Which strategy entered earlier/later?
- Did the book or AggTrade state distinguish successful Aegis entries?
- Did Momentum correctly avoid moves the others chased?
- Are there neutral quality features useful across strategies?

The black box must not automatically vote, rank, or select strategies in V2.

## 15. No-retroactive-use rule

When a new potentially useful feature is discovered from historical black-box data:

1. formulate the hypothesis;
2. freeze the feature definition;
3. define baseline vs treatment;
4. use untouched temporal validation/holdout or a new prospective cohort;
5. account for realistic costs;
6. use negative controls;
7. require stability, not a single favorable subset.

Do not add the feature directly to Aegis/Momentum/Micro Burst because it looked good on the same sample that discovered it.

## 16. Governance/provenance

Every official decision record must make it possible to identify:

- strategy ID;
- strategy version;
- code SHA;
- config hash;
- schema version;
- feature definition version;
- timestamps;
- cohort ID when applicable;
- source market snapshot ID.

Dataset outputs must also store builder version/hash and preregistration identity.

## 17. Implementation sequence

Do not build this entire system before Shared Market Data is qualified.

Recommended sequence:

1. shared order book;
2. shared AggTrade state;
3. quotes/candles/benchmarks;
4. shared neutral feature definitions;
5. causal `MarketSnapshotProvider`;
6. black-box contracts/storage;
7. Micro Burst observational attachment;
8. Aegis observational attachment;
9. Momentum observational attachment;
10. offline outcome/dataset tooling;
11. only later modeling experiments.

## 18. V2 success definition

Black Box V2 succeeds when:

- the same market reality can be referenced by multiple strategies;
- captured features are causally available at decision time;
- strategy-specific and shared features remain separated;
- logging on/off does not alter strategy decisions;
- no exchange mutation authority exists;
- outcome joins happen after the fact;
- dataset audits can detect missing/leaky/duplicate evidence;
- no ML gate is enabled.

It is an instrumentation/research success criterion, not a profitability claim.
