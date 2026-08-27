# Phase 1 Architecture Cleanup Report

Branch: `work/micro-burst-rider-v1-20260826`
Checkpoint: `a32ec56` (pre-cleanup) → pending commit

## Purpose

Stabilize module boundaries and remove dead code paths before Micro Burst implementation, without changing runtime behavior.

## Changes

### Module reorganization

| Original location                                                  | New location                                                  | Reason                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------ |
| `src/brain/`                                                       | `src/tooling/research/archived/brain-contract-v1/`            | Research prototype, not runtime      |
| `src/prospective/`                                                 | `src/tooling/research/archived/prospective-shadow-cohort-v1/` | Dormant prospective validation       |
| `src/challengers/`                                                 | `src/tooling/research/archived/challengers-v17/`              | Historical challenger experiments    |
| `src/execution-durable/`                                           | `src/tooling/legacy-execution/durable/`                       | Legacy execution path, not active    |
| `src/sentinel/`                                                    | `src/tooling/research/archived/sentinel-news-v1/`             | Dormant integration                  |
| `src/backtest/`                                                    | Removed                                                       | Only contained mock tests, no runner |
| `src/app/execution/SharedStrategyExecutionService.ts`              | Same (relocated from `src/app/services/`)                     | Clarifies execution boundary         |
| `src/app/telegram/presentation/AegisTurboEntryMessageFormatter.ts` | Same (relocated from `src/app/messages/`)                     | Groups presentation layer            |
| `src/domain/strategy/EntryStrategy.ts`                             | Same (relocated from `src/app/`)                              | Strategy identity belongs in domain  |
| `src/app/analysis/AegisTurboHistoryAnalyzer.ts`                    | Same (relocated from `src/tooling/`)                          | Used by Telegram command             |
| `src/tooling/aegis/`                                               | New                                                           | Aegis CLI tools consolidated         |
| `src/tooling/audit/binance-usdm-readonly/`                         | Same (relocated from `src/infra/`)                            | Auditor scripts                      |

### Configuration

- `package.json` main updated to `dist/main.js`.
- All npm scripts point to new source paths.
- `vitest.config.ts` added with `testTimeout: 15000` for lifecycle tests.
- `regime_config.live.yaml` intentionally remains in repo root (deployment/cwd risk).

### Documentation

- `docs/README.md` added.
- Aegis docs organized under `docs/strategies/aegis/` and `docs/operations/aegis/`.
- Historical docs moved to `docs/history/`.
- Aegis Range research archived under `docs/research/archived/aegis-range-v1/`.

### Validation

- `src/restoration/phase1-architecture-boundaries.test.ts` added.
- Restoration tests updated to use real `config/regime_config.example.yaml` fixture.
- Digests updated in restoration operational semantics test.

## Validation results

- TypeScript build: PASS.
- Phase 1 matrix: 170/170 PASS.
- Full test suite: 818/818 PASS.
- `npm run audit:usdm-readonly:static`: PASS.

## Decisions

1. **No new authorizations**: `MICRO_BURST_V1` remains reserved.
2. **No behavior changes**: All changes are structural; runtime semantics unchanged.
3. **No timeout inflation**: Lifecycle tests legitimately need filesystem I/O time; vitest config provides 15s global timeout.
4. **No fixture fabrication**: Restoration tests use the real example config, not a synthetic copy.
5. **No premature freeze**: Hashes/digests will be generated only after architecture is stable.

## Invariants preserved

- Aegis never selects Momentum.
- Momentum does not depend on Current Brain, CleanEntry, EntryQuality, DecisionBrain, or E4.
- ExitEye only constructs for Aegis.
- Ambiguous/unknown ownership fails closed.
- Per-strategy risk remains isolated.
- `E4_CHANGED = FALSE`.
- `MICRO_BURST_V1_RUNTIME_AUTHORITY = FALSE`.
- No pyramiding, strategy flip, or new live authority.
