# MICRO_BURST_V1 M3.2.4 — ARCHIVE BATCHING + COHORT STORAGE READINESS

**Status: COMPLETE**
**Date: 2026-08-27**
**Implementation Commit: da8a3d0eb370b3a254b56941d8ea27d05eae91d2**
**Soak Commit: d5ec61ecb297735718a0a8ccde239c8ef1577f2a**

---

## 1. Objective

Fix the one-segment-per-event archive degeneration so archival storage is suitable for a long-running SHADOW cohort. This milestone is **STORAGE ONLY** — no strategy, threshold, or execution changes.

## 2. Root Cause

M3.2.3 soak revealed 14,373 segments for 14,373 records — a 1:1 ratio. Every `appendRaw` call triggered `setImmediate(() => this.drainArchiveQueue())`, which flushed the single record immediately, producing one immutable gzip segment per event. Over hours of live data, this creates thousands of tiny files, each with gzip/Open overhead, degrading replay and storage efficiency.

## 3. Implementation

### 3.1 Partition-Aware Batching (`MicroBurstStorage.ts`)

- **Partition key**: `type\0symbol\0hourStartMs` — each unique combination gets its own pending batch.
- **Pending batch map**: `Map<string, PendingBatch>` replaces flat `archiveQueue`. Each batch has its own timer.
- **Flush triggers**:
  1. `batch.records.length >= maxArchiveBatchRecords` (default 200) — immediate flush.
  2. `maxBatchLatencyMs` timer (default 750ms) — flushes sparse batches.
  3. `flushAllBatches()` — called during graceful shutdown.
- **Gap recording**: On write failure, the batch's time range is recorded as a gap; storage marked unhealthy.
- **Legacy replay**: Unindexed files on disk (pre-batch segments) are merged with indexed results via directory scan fallback.

### 3.2 Health Metrics

New fields in `StorageHealth`:
- `activeBatchCount` — number of open pending batches.
- `openBatchRecords` — total records across all open batches.
- `segmentsWritten` — cumulative segment count.
- `averageRecordsPerSegment` — `writtenRecords / segmentsWritten`.

### 3.3 listArchiveFiles Fix

Previously short-circuited to only indexed files when any were found. Now always merges directory scan with index results, ensuring unindexed legacy segments remain discoverable.

## 4. Soak Evidence

**Run**: 300s isolated SHADOW soak, 2026-08-27T18:22:23Z
**Config**: BTC/ETH, `bookDepthLevels: 20`, `maxArchiveBatchRecords: 200`, `maxBatchLatencyMs: 750`

### 4.1 Runtime Health

| Metric | Value |
|--------|-------|
| Duration | 300s |
| Evaluations | 114 |
| Healthy Books | 2 (BTC + ETH) |
| BTC Healthy | true |
| Resyncs | 0 |
| Storage Errors | 0 |
| Live Execution | false |
| Overflow Records | 0 |
| Graceful Shutdown | queueDepth=0, queuedRecords=18,277, writtenRecords=18,277 |

### 4.2 SQLite Evidence

| Metric | Value |
|--------|-------|
| Total Segments | 15,730 |
| Total Records | 32,650 |
| Avg Records/Segment | ~2.1 |
| Max Records/Segment | 213 |
| Integrity Check | ok |

**By Type**:
- `depth`: 6,332 segments, 11,251 records (avg 1.78/seg)
- `trades`: 9,398 segments, 21,399 records (avg 2.28/seg)

**By Symbol**:
- `BTCUSDT`: 8,313 segments, 17,895 records (avg 2.15/seg)
- `ETHUSDT`: 7,417 segments, 14,755 records (avg 1.99/seg)

### 4.3 Batch Distribution

Record count distribution shows real multi-record batching:
- 213-record segment (1 segment)
- 201-record segment (1 segment)
- 165-record segment (1 segment)
- ...down to 1-record segments (legacy/tail)

**Before (M3.2.3)**: 14,373 segments = 14,373 records → avg 1.0/segment
**After (M3.2.4)**: 15,730 segments = 32,650 records → avg 2.1/segment

## 5. Test Coverage

24 storage tests pass (20 new for M3.2.4):
- Multi-record batching
- Max batch size trigger
- Timer-based flush for sparse batches
- Partition isolation (BTC vs ETH, trades vs depth)
- Hour rollover creates separate segments
- Graceful shutdown flushes partial batches
- queuedRecords == writtenRecords after flush
- Segment record_count matches NDJSON line count
- Metadata checksum matches content
- Mixed legacy/new replay
- Write failure marks unhealthy + records gap
- Queue overflow remains fail-closed
- Active batch count and open batch records health
- Outcome semantics unaffected by batching

**Full regression**: 1,076 tests pass.

## 6. Constraints Preserved

- Micro Burst remains SHADOW; no exchange mutations.
- Normal Aegis live execution unaffected.
- `MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = false`.
- No official cohort started.
- No strategy/risk/entry/exit changes.

## 7. Migration Notes

Existing one-record archive segments remain readable. The `listArchiveFiles` fix ensures unindexed legacy files are discoverable via directory scan. No migration required.

---

**Next**: M3.2.4 is complete. Official prospective cohort remains blocked pending product authorization.
