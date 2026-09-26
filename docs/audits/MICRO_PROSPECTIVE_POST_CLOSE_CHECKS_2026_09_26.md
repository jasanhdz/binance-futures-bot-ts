# Micro Prospective Post-Close Checks

Date: 2026-09-26

## Verification

- Cost evidence remains usable through a market-data gap and retains its original `costObservedAtMs`.
- A newly observed book is rejected when the persisted cost evidence exceeds `exitIntelligenceMaxObservationGapMs`.
- The productive `StrategyRuntimeCoordinator` lifecycle is covered for LONG and SHORT: start, real close, post-close gap, restart, economic recovery, cost expiry, and horizon completion.
- CURRENT prospective evaluation receives the same `exitContext` that LIVE routes to the position manager. This changes only observational input; LIVE execution authority and decisions remain unchanged.
- Capture remains disabled in `regime_config.live.yaml`.

## Historical Checkpoints

The full suite still reports four intentional checkpoint failures. They detect source changes that are already authorized by the prospective-cost work and were not rewritten to hide the diff:

- `src/app/ports/Exchange.ts`: expected `e5d2c403e034654851e19160aad0fdcfb5ea2622c431a4fd7ff79745efe1c203`, current `b745f32bbd67c59fa22a40fe1f21a491fe93e357e6eb4103fa7b56e08847244b`.
- `src/infra/adapters/BinanceAdapter.ts`: expected `b1ef4bcb1d67c942ad09c14ed94c83157bc8f3e9de516482624f4c540b4993df`, current `cbbf74b9285536911bcf5fa99d6da35db44ece377608e0b404f91ad1ce89508f`.
- `src/app/services/TradingService.ts`: expected `be754352a4f6c21a4bb6e41239994e004ae398486f7388fa3304a65748bb500f`, current `e9f6ee9380eedb1bdfa65d44edf11472a6e77339c076d42cd5c41d2ff67b4432` because the observational CURRENT/LIVE context parity fix is included.
- The fourth failure repeats the `Exchange.ts` baseline digest assertion.

These checkpoints remain unchanged pending an explicit baseline-update decision.
