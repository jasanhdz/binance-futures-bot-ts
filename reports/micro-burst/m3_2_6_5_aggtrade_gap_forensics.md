# M3.2.6.5 AggTrade Gap Forensics

Run: `20260828012014923-baed55f5b10e`  
Code SHA: `baed55f5b10e3ef57b0d1951c950769d06458062`

## Detector Audit

`MicroBurstAggTradeBuffer.push()` currently stores `lastTradeId` from the prior event's `lastTradeId` and declares a gap when:

```text
next.firstTradeId > previous.lastTradeId + 1
```

The detector therefore assumes contiguous underlying/raw trade IDs (`f/l`) between consecutive aggregate events. It does not currently compare `aggregateTradeId` (`a`).

The current production archive disproves that assumption as a continuity identity: all 425 detector gaps have consecutive aggregate IDs while their raw `f/l` ranges jump.

## Complete Archive Classification

Source: all `425` persisted `AGG_TRADE_SEQUENCE` rows, matched against all finalized trade archive records.

| Symbol | AGG_ID_CONTINUOUS_RAW_ID_GAP | AGG_ID_GAP | OUT_OF_ORDER | DUPLICATE | UNKNOWN | Total |
|---|---:|---:|---:|---:|---:|---:|
| BTCUSDT | 198 | 0 | 0 | 0 | 0 | 198 |
| ETHUSDT | 227 | 0 | 0 | 0 | 0 | 227 |
| **Total** | **425** | **0** | **0** | **0** | **0** | **425** |

The full row-level data is in `m3_2_6_5_aggtrade_gap_forensics.csv`.

## REST Cross-Check

The Binance USD-M Futures aggregate-trade REST endpoint was queried around representative retained intervals. `111/111` successful requests contained both the previous and next aggregate IDs, with no missing aggregate ID in the requested interval:

- BTCUSDT: `111/111` verified, missing `0`
- ETHUSDT: requests were rate-limited after the BTC sample
- REST missing aggregate events: `0` among successful checks
- REST unresolved due temporary `418/-1003` IP ban: `314`

The REST sample is consistent with the complete archive classification. The unresolved REST requests are an evidence-collection limitation, not an UNKNOWN detector classification.

## Binance Semantics

The official USD-M Futures Aggregate Trade Streams contract documents `a` as the aggregate trade ID, `f` as the first underlying trade ID, and `l` as the last underlying trade ID for the aggregate. The contract does not establish `f/l` contiguity as the stream continuity identity between successive aggregate events. The official documentation endpoint was inaccessible to the markdown fetcher during this audit; the live payload field mapping and REST response fields were verified directly.

## Conclusion

- Total suspected gaps: `425`
- False positives caused by the current raw `f/l` continuity detector: `425`
- Real missing aggregate events: `0` observed; `0` in successful REST checks
- Out-of-order: `0`
- Duplicates: `0`
- Unresolved detector classifications: `0`
- REST comparisons unresolved: `314` due rate limiting

Root cause is confirmed as an inappropriate continuity assumption: raw underlying trade IDs are not contiguous across consecutive aggregate-trade stream events. The detector should use consecutive `aggregateTradeId` values when available, retain `f/l` fields for diagnostics, and fail closed when the continuity identity is absent rather than infer it from raw IDs.
