# MICRO_BURST_V1 M0.3 Exact Structural Protection Report

Branch: `work/micro-burst-rider-v1-20260826`

Starting checkpoint: `deec294eb389747260448f5125db3cdc4107362f`

Scope: close the execution boundary from `StrategyExecutionIntent.structuralStopPrice` to `SharedStrategyExecutionService` and `exchange.placeStopClose()` without granting Micro Burst runtime authority or implementing M1 market data.

## Producer Audit

The repository has three production intent producers:

| Producer                                                   | Stop                  | Take profit / destination   | Runtime status                      |
| ---------------------------------------------------------- | --------------------- | --------------------------- | ----------------------------------- |
| `AegisExecutionIntentFactory`                              | `stopRoe`             | `takeProfitRoe`             | Existing LIVE-capable Aegis path    |
| Momentum intent in `TradingService.lookForMomentumEntry()` | `stopRoe`             | `takeProfitRoe`             | Existing LIVE-capable Momentum path |
| `createMicroBurstExecutionIntent()`                        | `structuralStopPrice` | software `destinationPrice` | OFF; no execution call site         |

No producer supplies both `stopRoe` and `structuralStopPrice`. No historical compatibility case requires precedence between them. Supplying both therefore fails closed with `reasonDetail: ambiguous_stop_specification`.

## Stop Semantics

### ROE stop

The existing path remains unchanged:

```text
confirmed fill + leverage + negative stopRoe
  -> bracketPrice(..., 'STOP')
  -> roundPrice(..., symbol filters)
  -> placeStopClose()
```

The `bracketPrice()` formula, leverage interpretation, tick rounding, take-profit handling, required-bracket verification, and emergency-close policy were not changed. Result metadata identifies this path with `stopSource: ROE` and retains `stopPrice` while also exposing `effectiveStopPrice`.

### Structural price stop

The structural path is absolute-price preserving:

```text
structuralStopPrice
  -> pre-open finite/positive validation
  -> marketOpen()
  -> confirmed real entry fill
  -> exchange tick rounding
  -> post-rounding side geometry validation
  -> placeStopClose(exact rounded price)
  -> exact stop-price verification
```

There is no conversion to ROE, leverage-dependent adjustment, ATR, percentage fallback, minimum-bps rule, or strategy policy in shared execution.

## Validation And Fail-Closed Rules

Before exchange mutation, a supplied structural stop must be finite and greater than zero. A required stop must have exactly one valid specification. Missing, invalid, or ambiguous specifications are denied with auditable `reasonDetail` metadata.

After position confirmation:

- LONG requires rounded structural stop `< confirmed entryPrice`.
- SHORT requires rounded structural stop `> confirmed entryPrice`.
- Equality after tick rounding is invalid.
- The executor does not move or repair an invalid stop.

Post-fill geometry failure, stop placement returning false, stop placement throwing, close-order listing failure, or absence of the exact rounded STOP enters the existing `BRACKETS_FAILED` protection path. When `closeIfProtectionFails` is true, the existing emergency market close is attempted immediately. Micro Burst keeps both `requireStop` and `closeIfProtectionFails` true.

## Rounding And Metadata

`roundPrice()` remains the sole normalization mechanism and uses the exchange `tickSize` and `pricePrecision`. Geometry is rechecked after rounding. Successful and failed structural attempts expose:

- `stopSource: STRUCTURAL_PRICE`
- `requestedStructuralStopPrice`
- `effectiveStopPrice`
- existing `stopPrice`, placement, verification, and recovery metadata

The close-order verification requires a STOP whose exchange-normalized trigger equals `effectiveStopPrice`; an unrelated stop at another price does not satisfy exact structural protection.

## Compatibility Guarantees

- Aegis continues to produce only ROE stop/TP intents.
- Momentum continues to produce only ROE stop/TP intents.
- `takeProfitRoe` behavior is unchanged.
- `destinationPrice` remains a Micro Burst software-exit destination and is not converted into an exchange TP.
- `StrategyExecutionIntent` remains backward-compatible; no `stopMode` or broad contract refactor was required.
- Micro Burst remains OFF and has no production call to `SharedStrategyExecutionService.execute()`.

## Validation

- Focused shared execution plus Micro Burst integration: 2/2 files, 26/26 tests PASS.
- Required Aegis/Momentum/Micro Burst matrix: 17/17 files, 240/240 tests PASS.
- Micro Burst: 12/12 files, 98/98 tests PASS.
- TypeScript build: PASS.
- Full suite: 83/83 files, 878/878 tests PASS.
- GitHub Actions: pending push.

## M1 Pending

M0.3 does not implement depth WebSocket ingestion, REST snapshot/diff synchronization, update-ID continuity, `aggTrade`, BTC stream, live reference price, temporal imbalance, absorption, sweep, tuning, SHADOW authority, or LIVE authority. Those remain M1 or later work.
