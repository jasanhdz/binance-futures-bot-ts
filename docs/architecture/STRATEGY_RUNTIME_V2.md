# Strategy Runtime V2

Status: architecture migration in progress. No Micro Burst strategy implementation is authorized in this phase.

## Objective

Turn the current monolithic TypeScript runtime into a strategy-oriented trading system in which Aegis Turbo, Momentum Ride, and future strategies are independent owners of their decisions and positions while reusing common market data, operational safety, exchange execution, persistence, and telemetry.

The migration must preserve current Aegis/Momentum behavior intentionally until each piece is moved behind the new boundaries. Compatibility adapters are temporary and must be explicit.

## Runtime layers

1. **Market Data Plane**
   - Exchange subscriptions and read-only market data.
   - No strategy ownership.

2. **Strategy Plane**
   - `StrategyRouter` selects a strategy by canonical `strategyId`.
   - Every strategy returns a normalized `StrategyDecisionEnvelope`.
   - A strategy decides setup/direction/abstention only; it does not call Binance.
   - Modes are strategy-owned: `OFF`, `SHADOW`, `LIVE`.

3. **Shared Safety Plane**
   - Account/operational constraints that are genuinely common: existing position, max trades, consecutive-loss budget, cooldown, liquidity stress, daily loss, later global exposure/kill switch.
   - Shared safety can veto. It must not manufacture a side or convert one strategy into another.
   - `SharedEntrySafetyGate` is the first extracted component.

4. **Execution Plane**
   - Accepts `StrategyExecutionIntent` only after strategy + safety approval.
   - Owns exchange mutation: leverage/margin mode, sizing normalization, market open, confirmation, brackets, emergency close, retry/recovery.
   - Strategies cannot invoke the exchange directly.

5. **Position Management Plane**
   - `PositionManagerRouter` routes an open position by persisted strategy ownership.
   - Aegis position lifecycle and Momentum position lifecycle are independent managers, even while both temporarily delegate to legacy code.
   - No manager may silently take ownership of another strategy's position.

6. **Telemetry / State Plane**
   - Every signal, trade, event, and persisted position carries canonical strategy attribution.
   - Required migration fields: `strategyId`, `strategyVersion`, `strategyHash`, `configHash`, `codeCommitSha`, freeze state where known.
   - Missing historical hashes remain explicitly unknown/unfrozen; never invent provenance.

## Canonical strategy IDs

- `AEGIS_TURBO`
- `MOMENTUM_RIDE`
- `MICRO_BURST_V1` reserved only; implementation remains forbidden until Aegis + Momentum migration is complete.

## Aegis boundary

Aegis keeps its current canonical scientific brain, hybrid direction contract, Aegis-specific guards, and frozen E4 downstream tail-risk veto. The migration must not move Momentum-specific regime/sizing rules into Aegis.

## Momentum boundary

Momentum Ride owns:

- the frozen `origin/main@3a6dbc330760aa8bf179be76c413623d7d50a420` stacking-momentum setup replication;
- its own enablement by symbol/side;
- its own leverage and position-fraction defaults/overrides under hard safety caps;
- its own position-management policy once extracted;
- RegimeEngineV2 context used only as Momentum metadata/confirmation according to Momentum configuration.

**RegimeEngineV2 is not a global Aegis filter.** It may expose reusable backend-style metadata, but Aegis does not inherit a Momentum gate simply because both strategies run in the same process.

## Migration order

1. Canonical identity/provenance contracts.
2. Strategy and position-manager routers.
3. Neutral telemetry attribution.
4. Shared operational safety extraction.
5. Momentum independent entry policy and risk configuration.
6. Route existing positions by persisted owner.
7. Extract shared execution service from `TradingService`.
8. Extract Aegis lifecycle manager.
9. Extract Momentum lifecycle manager.
10. Replace legacy `lookForEntry` branching with strategy coordinator(s).
11. Freeze/hash Aegis + Momentum runtime/config after architecture stabilizes.
12. Stabilize tests and recovery fixtures.
13. Only then begin `MICRO_BURST_V1` strategy implementation.

## Non-goals of this phase

- No new strategy rules.
- No Micro Burst entries.
- No optimization of thresholds.
- No modification of the scientific E4 model.
- No globalizing of Momentum's RegimeEngineV2 gate or sizing profile.
- No pretending legacy state is scientifically frozen when hashes are missing.
