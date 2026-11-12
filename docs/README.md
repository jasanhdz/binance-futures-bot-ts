# Documentation Authority Index

Use this page to find the canonical implementation contracts and historical evidence. A document's location does not grant live authority; runtime mode, persisted identity, shared safety, and execution checks remain authoritative.

## Current architecture and status

- [Runtime architecture](./architecture/README.md): current ownership, connected flows, target boundaries, and residual coupling.
- [Migration status](./architecture/MIGRATION_STATUS.md): implemented phase, verification, and next cut.
- [Strategy contracts](./architecture/STRATEGY_CONTRACTS.md): runtime contract types, strategy-specific inputs, outcome states, ownership, and future feature-schema boundary.
- [Arquitectura en español](./architecture/README.es.md): concise Spanish entry point to the canonical architecture.

## Shared market-data and learning architecture — current design authority

These documents describe current shared market capabilities and their qualification boundaries. They do not grant LIVE authority.

- [Shared Market Data Architecture](./architecture/SHARED_MARKET_DATA_ARCHITECTURE_V1.md): capability contracts, clocks, quality, snapshots, and current reuse boundaries.
- [Capability Composition V1](./architecture/MARKET_DATA_CAPABILITY_COMPOSITION_V1.md): tested non-owning catalog/profile prototype; not yet wired into runtime strategy evaluation.
- [Strategy Decision Black Box V2](./research/STRATEGY_DECISION_BLACKBOX_V2.md): operational observational decision/market evidence model and offline learning boundary. It does not authorize ML feedback into strategies.
- [Strategy Decision Black Box Storage V2](./research/STRATEGY_DECISION_BLACKBOX_STORAGE_V2.md): tiering, deduplication, rotation, compression and clean-start policy.

The governing principle is: **shared layers describe what the market is doing; strategies decide what it means.** A capability being available does not add a strategy dependency unless its contract declares it.

## Canonical-document and cleanup decisions

| Document                                                             | Unique information                                                    | Currency                                                                 | Action                              | Destination for useful content                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------- |
| `architecture/README.md`                                             | Runtime composition, authorities, boundaries                          | Updated for current code and target separation                           | Maintain and update                 | Canonical architecture                                                       |
| `architecture/STRATEGY_CONTRACTS.md`                                 | Identity/freeze rules and typed strategy requirements                 | Updated with implemented contracts; hash/freeze promotion remains future | Maintain and update                 | Canonical strategy contract                                                  |
| `architecture/SHARED_MARKET_DATA_ARCHITECTURE_V1.md`                 | Neutral feeds, timestamps, quality, snapshot contracts                | Updated to distinguish deployed, partial, and disconnected components    | Maintain and update                 | Canonical market-data architecture                                           |
| `architecture/MIGRATION_STATUS.md`                                   | Current implementation, tests, residual couplings                     | Updated                                                                  | Maintain and update                 | Canonical implementation status                                              |
| `strategies/micro-burst/README.md`                                   | Micro policy, input requirements, limitations                         | Updated; profitability remains unproven                                  | Maintain and update                 | Canonical Micro reference                                                    |
| `micro-paired-replay-evidence.md`                                    | Capture/replay contract and V7 findings                               | Updated with sequenced-clock/persistence limits                          | Maintain and update                 | Canonical capture/replay procedure and evidence summary                      |
| `research/micro-observer-v7/`                                        | Full requests, before/after JSON reports, hashes, executor provenance | Immutable historical evidence, capture excluded                          | Archive as evidence                 | Durable V7 replay evidence                                                   |
| `architecture/SHARED_MARKET_DATA_CLASSIFICATION.md`                  | Code classification at its recorded baseline SHA                      | Historical baseline, superseded by the current inventory                 | Retain as historical evidence       | Keep original baseline/provenance; current state is in `MIGRATION_STATUS.md` |
| `architecture/MARKET_DATA_CONVERGENCE_PHASE_R.md`                    | Phase-R extraction results                                            | Historical implementation report                                         | Retain as historical evidence       | Keep report; current integration is in architecture/status docs              |
| `architecture/MARKET_DATA_CAPABILITY_COMPOSITION_V1.md`              | Tested but disconnected consumer-profile composition                  | Valid prototype, not a runtime dependency                                | Maintain with corrected status      | Future integration reference; not current authority                          |
| Former `architecture/SHARED_MARKET_DATA_MIGRATION_PLAN.md`           | Superseded A–Z roadmap and repeated gates                             | Stale after completed implementation waves                               | Eliminated                          | Current gaps summarized in `MIGRATION_STATUS.md`                             |
| `architecture/STRATEGY_RUNTIME_V2.md`                                | Earlier target diagram/order of work                                  | Superseded by current runtime architecture/status                        | Replace with short redirect         | Current authority/boundaries in `README.md`; status in `MIGRATION_STATUS.md` |
| `architecture/README.es.md`, `architecture/STRATEGY_CONTRACTS.es.md` | Translations of canonical English docs                                | Long copies had drifted from runtime                                     | Replace with short Spanish pointers | Keep entry points, avoid maintaining duplicate specifications                |

## Aegis strategy references

Entry policy and guards:

- [Entry Policy](./strategies/aegis/entry/AEGIS_ENTRY_POLICY.md)
- [Clean Entry Guard](./strategies/aegis/entry/AEGIS_CLEAN_ENTRY_GUARD.md)
- [Entry Quality Gate](./strategies/aegis/entry/AEGIS_ENTRY_QUALITY_GATE.md)
- [Event Risk Overlay](./strategies/aegis/entry/AEGIS_EVENT_RISK_OVERLAY.md)
- [Regime Guard](./strategies/aegis/entry/AEGIS_REGIME_GUARD.md)

Position lifecycle:

- [Exit Eye](./strategies/aegis/lifecycle/AEGIS_EXIT_EYE.md)
- [Profit Protection](./strategies/aegis/lifecycle/AEGIS_PROFIT_PROTECTION.md)

## Operations

- [Configuration inheritance](./operations/aegis/AEGIS_CONFIG_INHERITANCE.md)
- [Risk stabilization](./operations/aegis/AEGIS_RISK_STABILIZATION.md)
- [Telegram commands](./operations/aegis/AEGIS_TELEGRAM_COMMANDS.md)
- [Telegram notifications](./operations/aegis/AEGIS_TELEGRAM_NOTIFICATIONS.md)

## Historical and archived material

These documents preserve prior plans or research context and are not current runtime authority:

- [Aegis TypeScript integration plan](./history/AEGIS_TS_INTEGRATION_PLAN.md)
- [Strategy Runtime V2 Phase 1 Codex handoff (Spanish)](./history/CODEX_PHASE1_MIGRATION_HANDOFF.es.md)
- [Phase 1 architecture cleanup report](./architecture/PHASE1_CLEANUP_REPORT.md)
- [Archived Aegis Range V1 research pointer](./research/archived/aegis-range-v1/README.md)
- [Shared market-data classification at its reviewed SHA](./architecture/SHARED_MARKET_DATA_CLASSIFICATION.md)
- [Market-data convergence Phase R report](./architecture/MARKET_DATA_CONVERGENCE_PHASE_R.md)
- Dated Micro operational/audit reports and negative controls under `./strategies/micro-burst/`, `./audits/`, and `./experiments/` remain historical evidence; they are not current strategy contracts or profitability claims.
