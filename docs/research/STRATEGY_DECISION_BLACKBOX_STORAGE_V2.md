# Strategy Decision Black Box Storage V2

**Status:** operational evidence storage; observational and fail-open
**Trading authority:** none
**Decision schema:** `StrategyDecisionEvidenceV2` (`schemaVersion: 2`)

## Objective

Keep enough causal evidence to audit and reproduce meaningful strategy decisions without copying
hundreds of candles into every routine `NO_TRADE` record or allowing append-only JSONL files and
pending writes to grow without an operational bound.

This storage layer never changes a signal, threshold, risk rule, model, or execution decision.

## Active layout

New runtime evidence is written to:

- `data/strategy-blackbox/strategy-decisions/decisions-v2.jsonl`
- `data/strategy-blackbox/market-snapshots/snapshots-v2.jsonl`
- `data/strategy-telemetry/events-v2.jsonl`

Black Box V2 does not read, append, migrate, or import V1 decision files. A clean deployment may
remove the obsolete V1 dataset through a separate, explicitly audited operation while the bot is
stopped. Runtime code contains no V1 fallback.

## Candidate boundary

Momentum first performs its pure market-pattern preflight. Account, exposure, safety, router, and
Black Box work begin only after that pattern exists. This avoids treating every periodic scan as an
independent research candidate and prevents large replay payloads for evaluations that never
reached the candidate boundary.

## Evidence tiers

| Tier          | Used for                                            | Stored evidence                                                         |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `FULL_REPLAY` | `ENTRY_INTENT`, matched patterns, evaluation errors | Complete strategy replay required for reconstruction                    |
| `COMPACT`     | Routine vetoes and `NO_TRADE` decisions             | Diagnostics plus candle count, temporal bounds, and SHA-256 replay hash |

The compact hash fingerprints the exact replay that produced the decision without duplicating all
candle objects in every record; compact records are auditable summaries, not full reconstructions.
The authoritative decision record remains in the Black Box. Generic
strategy telemetry stores its identifiers and operational summary, not a second diagnostics copy.

## Shared market snapshots

Snapshots with identical causal market content are stored once within a five-minute runtime
window. Differences limited to local capture boundaries reference the first canonical snapshot.
The shared `MarketSnapshotV1` input is persisted inside a
`STRATEGY_MARKET_SNAPSHOT_EVIDENCE_V2` envelope containing the V2 storage schema, content hash and
recording boundary; raw V1 snapshot records are not appended directly.
Every decision retains:

- the canonical `marketSnapshotId`;
- the canonical market-content SHA-256;
- the originally observed snapshot id when it differs;
- whether a new snapshot record was stored.

Feature values, source timestamps, health, and provenance remain part of the content hash, so a
real market or quality change always creates a new snapshot.

## File and memory bounds

Each active JSONL file rotates at 256 MiB by default. Rotated files are compressed with gzip in the
background at a low CPU compression level; shutdown drains queued writes and compression tasks.
Writes are serialized and the default pending queue is capped at 256 records. Overload rejects evidence fail-open instead of
allowing unbounded process memory growth.

Time-based retention is supported by the writer but is disabled unless explicitly configured.
No evidence is automatically deleted in the production composition.

## Diagnostics

`GET /diagnostics/market-data` includes `blackBoxStorage` with:

- records and bytes written;
- rotations and compression results;
- pending and peak pending writes;
- overload rejections;
- stored and deduplicated market snapshots;
- observation failures.

These metrics are operational evidence only and confer no runtime authority.

## Remaining research work

Storage V2 bounds collection and preserves causal join keys. A transversal offline outcome linker,
episode builder, cohort manifest, and anti-leakage dataset audit remain separate research phases.
They must not be implemented by feeding future outcomes back into decision-time records.
