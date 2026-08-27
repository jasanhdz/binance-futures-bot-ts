# MICRO_BURST_V1 M3.2.5 — DURABLE ROLLING ARCHIVE

**Status: storage infrastructure qualified for cohort freeze, not cohort activation**

## Code And Provenance

- Code SHA tested: `63cd61efe498856422f312266ace38bccbf8f0b7`
- CI: GitHub Actions run 72, completed/success on that exact SHA.
- Retained run ID: `20260827T190300Z`
- Mode: `SHADOW`; `liveExecution=false`; official=false.
- Config: `/tmp/opencode/m3_2_5-clean-soak.yaml`
- Config SHA-256: `d1b22640ff47dd03984e1e5b0c4deaddb6ec5f1e2aaa5a3edd2b6871c86c170e`
- Archive root: `data/micro-burst/soaks/m3_2_5/20260827T190300Z/archive`
- Database: `data/micro-burst/soaks/m3_2_5/20260827T190300Z/research.sqlite`

## M3.2.4 Correction

M3.2.4 retained SQLite mixed M3.2.3 data: 14,373 legacy records/segments plus a new
18,277 records/1,357 segments. The true new-run rate was 13.47 records/segment, not the
misleading cumulative 2.1. At that rate it would generate about 390,816 segments/day and
781,632 final gzip/metadata files/day. It was not cohort-ready.

## Architecture

```
event -> append-only type/symbol/hour .active.ndjson -> <=1s fsync checkpoint
      -> record/byte/duration rotation -> gzip .tmp -> fsync -> atomic rename
      -> metadata .tmp -> fsync -> atomic rename -> SQLite one-row segment index
```

- Partition key: `type\0symbol\0hourStartMs`.
- One active spool per partition; final segments never cross an hour.
- Rotation: 5,000 records, 8 MiB, or 120 seconds.
- Durability window: timer schedules `fsync` no later than 1,000ms after an append.
- Finalization is synchronous and bounded: no asynchronous compression backlog; queue depth is always zero.
- Normal shutdown finalizes every spool and leaves no active/temp artifacts.

Process crash: complete spool lines written before the crash are recovered on startup. Machine-crash
durability is bounded by the configured fsync window; bytes written after the last fsync may be lost.
Torn active trailing lines are ignored, produce a durable gap, and make storage unhealthy.

## Recovery

Startup repairs gzip temporary files, missing metadata, and final gzip files missing SQLite rows.
It retains the active spool until gzip, metadata, and index are recoverable. If a completed final
segment has the same checksum as its spool, recovery removes the spool rather than duplicating it.

Isolated SIGKILL test:
- 1,000 records accepted before abrupt termination after a durability checkpoint.
- 1,000 records recovered into one segment.
- Duplicates: 0; gaps: 0; recovery failures: 0; final health: healthy.

## Tests

`npm run build` passed. `npx vitest run` passed: 103 files, 1,084 tests.

The 32 storage tests cover active durability checkpoints, record/byte/duration/hour rotations,
partition isolation, gzip/metadata/index integrity, legacy and mixed replay, active-spool recovery,
torn lines, missing index repair, overflow/failure behavior, outcomes, and clean shutdown.

## Fresh 600s Retained Soak

The root was empty before start: 0 segment rows, 0 gaps, 0 signals, 0 gzip files.

| Metric | Value |
| --- | ---: |
| Duration | 600s |
| Accepted/written records | 26,225 / 26,225 |
| Finalized segments | 20 |
| Average records/segment | 1,311.25 |
| Minimum/maximum records/segment | 717 / 2,165 |
| Final gzip / metadata files | 20 / 20 |
| Active / temporary files at shutdown | 0 / 0 |
| Gaps / overflow / storage errors | 0 / 0 / 0 |
| SQLite integrity | `ok` |
| SQLite rows / `SUM(record_count)` | 20 / 26,225 |
| BTC/ETH books | healthy / healthy |
| BTC context after 120s | healthy |
| Resyncs | 0 |
| WS stale warnings / book gaps | 0 / 0 |

Per partition: BTC trades 5/7,307; BTC depth 5/5,747; ETH trades 5/7,447; ETH depth 5/5,724
(segments/records). Two gzip segments from each type/symbol partition were gunzipped and verified:
line count, SHA-256, metadata, SQLite count, and time bounds all matched.

Graceful shutdown reported `archiveQueueDepth=0`, `archiveQueuedRecords=26225`,
`archiveWrittenRecords=26225`, `archiveOverflowRecords=0`, and `storageErrors=0`.

## Safety And Freeze Tasks

Micro Burst remained SHADOW and did not receive live authority; the normal PM2 bot was not restarted.
This milestone makes storage suitable to freeze a cohort, not to start one. Remaining freeze inputs:
official cohort ID, exact archive/database namespace, preregistration, horizons/costs/controls,
minimum sample and duration, no-tuning rule, start timestamp, and explicit authorization.
