# M3.2.6.5 AggTrade Continuity Report

## Verdict

`MICRO_BURST_V1_M3_2_6_5_AGGTRADE_CONTINUITY_BLOCKED`

The detector root cause was proven and fixed, but the required short runtime validation remained blocked by a Binance REST IP rate-limit ban. No 900-second soak was run after the fix.

## Forensic Classification

- Total suspected gaps: `425`
- False positives: `425`
- Real missing aggregate events: `0` observed; `0` in `111/111` successful REST checks
- Out-of-order: `0`
- Duplicates: `0`
- Unresolved detector classifications: `0`
- REST comparisons unresolved: `314`, after Binance returned `418/-1003`
- BTC: `198` false `f/l` continuity gaps
- ETH: `227` false `f/l` continuity gaps

All retained rows had consecutive aggregate IDs (`a`) and discontinuous raw underlying IDs (`f/l`). The detector incorrectly used `next.f > previous.l + 1`.

## Binance Semantics

The USD-M Futures Aggregate Trade payload identifies `a` as aggregate trade ID, `f` as first underlying trade ID, and `l` as last underlying trade ID. The observed stream and REST data demonstrate that `f/l` are not a valid continuity identity across consecutive aggregate events. The official documentation page was unavailable to the fetcher during this audit; field mapping was verified from live payloads and REST responses.

## Code Change

- Continuity now uses `aggregateTradeId`.
- Raw `firstTradeId` and `lastTradeId` remain diagnostic fields.
- True aggregate ID jumps remain fail-closed.
- Duplicate and out-of-order aggregate IDs do not create false gaps.
- Missing aggregate identity remains fail-closed.
- Gap dedupe state remains bounded.

Code SHA: `6eaccd59dd8ef47f1a36b7ab240ef52d9d292bd8`  
CI run: `33134933414`, success  
CI head SHA: `6eaccd59dd8ef47f1a36b7ab240ef52d9d292bd8`

## Validation

- Build: passed
- Full tests: `107` files, `1,176` tests passed
- Targeted continuity tests: passed
- Production-path smoke: `90s`, BTC depth `874`, ETH depth `871`, BTC AggTrade `1,550`, ETH AggTrade `1,004`, reconnects `0`, mutations `0`
- Short runtime validation: `362.847s`
- Short validation run: `20260828020903979-6eaccd59dd8e`
- Short BTC/ETH archived AggTrades: `8,581 / 5,564`
- Short gaps: `0`
- Short `gapFree`: `true` for both symbols
- Short `windowComplete`: not reached because BTC context stayed unhealthy
- Short valid contexts: `0`
- Short mutations: `0`
- Short blocker: `BTC_NOT_READY` caused by REST candle requests rejected with `418/-1003` IP ban

The short run showed `gaps=true`, `books=true`, and `AggTrade=true`; it did not satisfy the final readiness gate because BTC context could not refresh candles while REST was banned.

## Files

- `reports/micro-burst/m3_2_6_5_aggtrade_gap_forensics.csv`
- `reports/micro-burst/m3_2_6_5_aggtrade_gap_forensics.md`
- `scripts/micro-burst-m3_2_6_5-forensic.ts`
- `src/domain/strategies/micro-burst/MicroBurstAggTradeBuffer.ts`
- `src/domain/strategies/micro-burst/MicroBurstAggTradeBuffer.test.ts`
- `src/domain/strategies/micro-burst/MicroBurstRuntime.ts`

## Next Gate

After the REST ban expires, rerun only the short runtime validation on the exact committed code SHA. Require both symbols to reach `windowComplete=true`, `gapFree=true`, valid contexts greater than zero, and zero mutations. Do not repeat the 900-second soak until that validation passes.
