# MICRO_BURST_V1 — Tactical Scalping Strategy

## Overview

MICRO_BURST_V1 is a deterministic scalping strategy that captures small price movements from nearby support/resistance levels using micro-momentum confirmation and fast exit on anomaly/deterioration.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TradingService / StrategyRouter           │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│               MicroBurstContextBuilder                      │
│  Inputs: candles 1m/3m/5m, BTC context, order book          │
└─────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
    ┌─────────────┐ ┌──────────────┐ ┌──────────────┐
    │ S/R Detect  │ │  Momentum    │ │  Book        │
    │             │ │  Analyzer    │ │  Pressure    │
    └─────────────┘ └──────────────┘ └──────────────┘
              │              │              │
              └──────────────┼──────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                 MicroBurstEntryPolicy                       │
│  Decision tree: clarity → level → momentum → BTC → book     │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                 MicroBurstLeveragePolicy                    │
│  HIGH (>=0.75) = 40x | MEDIUM (>=0.50) = 20x | LOW = skip  │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Shared Safety Layer                      │
│  Account risk, symbol lock, cooldown, daily limits          │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│             SharedStrategyExecutionService                  │
│  Leverage, isolated margin, market open, brackets           │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│              MicroBurstPositionManager                      │
│  Early failure, anomaly, trailing, break-even, max hold     │
└─────────────────────────────────────────────────────────────┘
```

## Decision Flow

1. **Structural clarity?** — Clear S/R levels + trending/ranging regime + book healthy → continue
2. **Near a useful level?** — near_support or near_resistance → continue
3. **Momentum confirms?** — Direction matches level type → continue
4. **BTC doesn't contradict?** — No conflict flag → continue
5. **Book/tape healthy?** — No anomaly → continue
6. **Entry** — LONG near support + upward momentum, SHORT near resistance + downward momentum

## Files

| File | Purpose |
|---|---|
| `MicroBurstTypes.ts` | All shared types and default config |
| `MicroBurstIdentity.ts` | Strategy identity factory |
| `MicroBurstSupportResistance.ts` | Swing-point S/R detection with clustering |
| `MicroBurstMomentumAnalyzer.ts` | Multi-timeframe micro-momentum analysis |
| `MicroBurstMicroRegime.ts` | Micro regime classification |
| `MicroBurstBookPressureAnalyzer.ts` | Order book pressure analysis |
| `MicroBurstContextBuilder.ts` | Assembles full strategy context |
| `MicroBurstLeveragePolicy.ts` | Leverage tier selection |
| `MicroBurstEntryPolicy.ts` | Entry decision engine |
| `MicroBurstExitPolicy.ts` | Exit decision engine |
| `MicroBurstStrategy.ts` | Strategy class (implements EntryStrategy) |
| `MicroBurstPositionManager.ts` | Position lifecycle management |

## Invariants

- `MICRO_BURST_V1_RUNTIME_AUTHORITY = FALSE` (mode defaults to OFF)
- No Aegis dependencies (no Current Brain, E4, ExitEye)
- No Python dependencies
- Fail closed on ambiguous data
- No duplicate positions per symbol
- Reuses SharedStrategyExecutionService and SharedEntrySafetyGate
- No behavior changes to Aegis or Momentum paths

## Lifecycle Policy

Uses `MICRO_BURST_RESERVED_POLICY`:
- `useLegacyProfitGuardian: false`
- `useBreakEven: false`
- `useTrailing: false`
- `requireStopBracket: true`
- `requireTakeProfitBracket: false`
- `closeIfBracketFails: true`
- `allowManualQuantityReconciliation: false`

## Exit Reasons

- `EARLY_FAILURE` — No continuation within window, or adverse excursion beyond threshold
- `ANOMALY` — Book anomaly, BTC reversal, or anomaly flag
- `TARGET` — Reached target level
- `TRAILING` — Trailing stop activated in profit
- `MAX_HOLD` — Exceeded max hold time (default 5 minutes)
- `BREAK_EVEN` — Stop moved to break-even after profit threshold

## Leverage Tiers

| Tier | Confirmation | Leverage | Position Fraction |
|---|---|---|---|
| HIGH | >= 0.75 | 40x | 9% |
| MEDIUM | >= 0.50 | 20x | 5% |
| NO_TRADE | < 0.50 | — | — |
