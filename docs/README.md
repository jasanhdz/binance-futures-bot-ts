# Documentation Authority Index

Use this page to distinguish current runtime documentation from historical plans and archived research. A document's location does not grant live trading authority; runtime and strategy authority remain subject to the contracts and status recorded below.

## Current architecture and status

- [Runtime architecture](./architecture/README.md) and [Spanish version](./architecture/README.es.md): architectural boundaries and design context.
- [Migration status](./architecture/MIGRATION_STATUS.md): current implementation checkpoint and remaining migration work.
- [Strategy Runtime V2](./architecture/STRATEGY_RUNTIME_V2.md): current runtime-layer and strategy-isolation reference.
- [Strategy contracts](./architecture/STRATEGY_CONTRACTS.md) and [Spanish version](./architecture/STRATEGY_CONTRACTS.es.md): strategy ownership, reproducibility, and freeze contracts.

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
- [Archived Aegis Range V1 research pointer](./research/archived/aegis-range-v1/README.md)
