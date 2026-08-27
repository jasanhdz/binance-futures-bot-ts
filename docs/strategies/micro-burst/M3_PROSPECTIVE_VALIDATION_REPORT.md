# MICRO_BURST_V1 M3 — Prospective Shadow Outcome Validation

## Status: MICRO_BURST_V1_M3_PROSPECTIVE_VALIDATION_READY

## Architecture

### Entry Plane ≠ Outcome Plane

The architecture enforces strict separation:

- **Entry Plane**: `MicroBurstRuntime` → `MicroBurstShadowEvaluator` → `StrategyRouter` → `MicroBurstStrategy` → `evaluateMicroBurstEntry()` → `ENTRY_INTENT` / `NO_TRADE`
- **Outcome Plane**: `MicroBurstOutcomeTracker` observes prices after T0, computes outcomes, never participates in entry evaluation

### Signal Immutability

When a `wouldEnter` signal is generated at T0:

1. A `ShadowSignalSnapshot` is frozen with ALL decision data
2. The snapshot is immutable — no post-T0 data can alter it
3. Side, entry price, stop, target, confidence, leverage are all frozen
4. The outcome tracker observes ONLY post-T0 prices

### Version

- `MICRO_BURST_V1_VERSION = '0.4.0-prospective-validation'`
- `MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED = true`
- `MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = false`

## Components

### Domain Layer (Pure Functions)

**`MicroBurstOutcomeTypes.ts`** — All type definitions:

- `ShadowSignalSnapshot` — frozen signal at T0
- `EntryPriceModel` — SIGNAL_PRICE, NEXT_TRADE, CONSERVATIVE_SLIPPAGE
- `CostScenario` — configurable fee + slippage
- `HorizonOutcome` — MFE/MAE/return per horizon
- `BarrierOutcome` — TARGET_FIRST, STOP_FIRST, NEITHER, AMBIGUOUS
- `DynamicExitOutcome` — counterfactual exit simulation result
- `ProspectiveOutcomeRecord` — complete outcome journal entry
- `PendingOutcome` — in-memory state for tracking

**`MicroBurstOutcomeEngine.ts`** — Pure computation:

- `sideAwareReturnBps()` — LONG: (price/entry-1), SHORT: (entry/price-1)
- `computeHorizonOutcome()` — MFE/MAE/barrier per horizon
- `computeAllHorizons()` — all 5 horizons
- `aggregateBarrierOutcome()` — cross-horizon barrier
- `computeCostScenarios()` — net returns per cost scenario
- `computeEntryModels()` — 3 entry price assumptions
- `simulateDynamicExit()` — reuses `evaluateMicroBurstExit()`
- `freezeSignalSnapshot()` — creates immutable snapshot
- `createPendingOutcome()` — initializes tracking state

### Application Layer (I/O)

**`MicroBurstOutcomeTracker.ts`** — Manages pending outcomes:

- `trackSignal()` — registers frozen snapshot
- `processTradeEvent()` — feeds price data after T0
- `flushPending()` — force-completes matured outcomes
- Memory-bounded: max 500 pending, ring buffer for price history
- Idempotent: duplicate signal IDs are ignored
- Eviction: oldest pending removed when over limit

**`MicroBurstOutcomeJournal.ts`** — JSONL append-only:

- Persisted to `logs/micro-burst/shadow-outcomes/`
- File rotation at 10,000 entries
- Idempotency by `shadowSignalId`
- `loadAll()` for analyzer
- `loadPendingSignalIds()` for restart recovery

**`MicroBurstProspectiveAnalyzer.ts`** (via `scripts/micro-burst-analyze-shadow.ts`):

- Reads signal + outcome journals
- Per-horizon analysis: mean/median/p10/p25/p75/p90
- Cost scenario analysis
- Segment diagnostics (symbol, tier, regime, BTC)
- Dynamic exit summary
- Negative controls (shuffled timestamps, random side)

## Outcome Horizons

Measured from T0:

- 15s, 30s, 60s, 120s, 300s

For each horizon:

- MFE bps (max favorable excursion)
- MAE bps (max adverse excursion)
- finalReturnBps
- timeToMfeMs, timeToMaeMs
- stopTouched, targetTouched
- barrierOutcome (TARGET_FIRST / STOP_FIRST / NEITHER / AMBIGUOUS)
- firstTouchAtMs
- tradeCount

## Entry Price Models

A. **SIGNAL_PRICE** — market/reference price frozen at T0
B. **NEXT_TRADE** — first valid trade after signalAtMs
C. **CONSERVATIVE_SLIPPAGE** — signal price + adverse buffer

Models are kept separate. Results are never mixed.

For `CONSERVATIVE_SLIPPAGE`, the adverse entry adjustment is already reflected in
the entry price. Cost components therefore expose it separately and subtract it
from scenario slippage before charging any additional slippage. The frozen
`cost_0` through `cost_30` values remain unchanged for the primary signal-price
accounting.

## Cost Scenarios

| Label   | Fee bps | Slippage bps | Total cost |
| ------- | ------- | ------------ | ---------- |
| cost_0  | 0       | 0            | 0          |
| cost_10 | 7       | 3            | 10         |
| cost_14 | 10      | 4            | 14         |
| cost_20 | 14      | 6            | 20         |
| cost_30 | 20      | 10           | 30         |

## First-Touch Semantics

- Uses real trade-level data for temporal ordering
- When both stop and target touched in same eventTime: `AMBIGUOUS_SAME_INTERVAL`
- Never assumes favorable ordering
- LONG: stop = price <= structuralStop, target = price >= destination
- SHORT: stop = price >= structuralStop, target = price <= destination

## Dynamic Exit Counterfactual

Reuses the existing `evaluateMicroBurstExit()` from `MicroBurstExitPolicy.ts`:

- HARD_INVALIDATION, TARGET, BREAK_EVEN, TRAILING, EARLY_FAILURE, BTC_REVERSAL, ANOMALY_EXIT, MAX_HOLD, HOLD_AT_HORIZON
- Simulates position lifecycle against price trajectory
- No new exit logic — purely shadow simulation
- When replayed from AggTrade archives without a mark-price archive, exits are
  labeled counterfactual and must not be described as executable mark fills.

## Independent Episodes

- Episode key: `${symbol}:${side}:${structuralLevel}`
- Two signals from the same setup belong to the same episode
- Prevents pseudo-replication in economic analysis
- Each outcome linked to its episode via `episodeId`
- Bootstrap, attrition, and candidate/control superiority are reported per
  episode, not per correlated signal row.

## Restart Recovery

- Pending signal IDs can be reconstructed from signal journal
- Outcome journal has idempotency by `shadowSignalId`
- Completed outcomes are not duplicated

## Memory Safety

- Max 500 pending outcomes in memory
- Price history ring buffer: 2000 events per signal
- Oldest pending evicted when over limit
- Completed outcomes removed from memory immediately

## Anti-Lookahead Guarantees

Verified by tests:

- Frozen signal snapshot is immutable
- Post-T0 trades cannot alter entry price model
- Post-T0 data cannot change structural stop/target
- Trades at or before T0 are rejected
- Side is frozen and cannot flip
- Deterministic: same input = same output

## Negative Controls

- `RANDOM_SIDE` uses a seeded side draw on the original archived trajectory.
- `TIME_SHIFT` uses the first archived trade strictly after a forward-shifted
  T0 and the subsequent archived trajectory; source entry and barriers are not
  copied.
- Controls are unavailable when raw archived trajectories are unavailable; no
  return inversion, row reordering, or timestamp shuffling is substituted.

## Baselines (Planned for Offline Analysis)

A. RANDOM_TIME_SAME_SIDE — random timestamps with same symbol/side/horizon
B. TIME_SHIFT — shifted signals preserving side
C. Simple momentum baseline (optional)

## Static Firewall

Extended to include M3:

- Domain files: no exchange mutation, no Exchange port import, no Date.now()
- Application files: no exchange mutation, no SharedStrategyExecutionService import
- LIVE authority: false
- Outcome tracker: no exchange mutation authority

## Tests

### New Test Files (60+ tests)

- `MicroBurstOutcomeEngine.test.ts` — 25 tests: side-aware returns, horizons, first-touch, costs, entry models, dynamic exit, freeze snapshot, pending outcome
- `MicroBurstOutcomeAntiLookahead.test.ts` — 12 tests: immutability, lookahead rejection, negative controls, determinism
- `MicroBurstOutcomeJournal.test.ts` — 8 tests: append, dedup, JSONL validity, credentials, immutability
- `MicroBurstOutcomeTracker.test.ts` — 10 tests: tracking, dedup, trade processing, completion, eviction, restart recovery

### Regression

- All 1022/1022 tests pass
- M0, M1, M2, M2.1, Aegis, Momentum, Shared Execution, routers, restoration, static firewall — all green

## Usage

```bash
# Run analyzer
npm run micro-burst:analyze-shadow

# With custom directories
npx tsx scripts/micro-burst-analyze-shadow.ts --signals-dir logs/micro-burst/shadow-signals --outcomes-dir logs/micro-burst/shadow-outcomes
```

## Limitations

1. **No live execution**: M3 maintains `LIVE_AUTHORITY_ENABLED = false`
2. **No tuning during collection**: Thresholds must not be modified while a cohort is active
3. **Sample size**: Do not declare economic edge with small N
4. **Version isolation**: Different strategy versions must not share cohorts

## Next Steps

- Accumulate prospective signals in SHADOW mode
- Run analyzer periodically to monitor outcome distributions
- When sufficient N is reached, evaluate for potential economic edge
- Do NOT declare LIVE_READY during M3
