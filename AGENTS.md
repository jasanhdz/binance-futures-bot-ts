# Repository Guidelines

## Project Structure & Module Organization
The trading runtime starts in `src/main.ts`, which wires configuration and kicks off scheduling. Core services live under `src/app/`, while domain models such as orders, indicators, and positions reside in `src/core/`. Exchange and persistence adapters are in `src/infra/`, and signal generation code is split between `src/scanner/` and `src/strategies/`. CLI tools, including the momentum scanner and backtest runners, live in `src/tools/`. Datasets go to `data/`, training artifacts to `train/`, documentation to `docs/`, and runtime logs to `logs/`.

## Build, Test, and Development Commands
Use `npm run dev:testnet` to exercise the bot against the Binance testnet with `.env.testnet`. Run `npm run dev:prod` for live trading using `.env`. Compile TypeScript with `npm run build`, then launch compiled builds through `npm run start:testnet` or `npm run start:prod`. Execute unit suites via `npm run test`, and regenerate feature vectors with `npm run verify:feats`. Trigger the TypeScript backtest runner using `npm run bt`.

## Coding Style & Naming Conventions
Write TypeScript with ES modules, keeping 2-space indentation. Exported members should declare explicit types, functions use `camelCase`, classes `PascalCase`, and environment keys `UPPER_CASE`. Run `npm run format` before committing to enforce Prettier spacing, quote style, and import ordering.

## Testing Guidelines
Vitest drives unit and integration coverage; place specs next to features and name them `*.test.ts`. Prefer deterministic fixtures from `data/` to emulate markets. Extend `src/backtest/runner.ts` when introducing new strategies and record expected metrics.

## Commit & Pull Request Guidelines
Commit messages stay short and imperative, e.g., `add momentum scanner`. Pull requests must describe strategy changes, risk impacts, supporting commands, and link issues when available. Include backtest outputs or screenshots for new trading logic and highlight any required `.env` updates.

## Security & Configuration Tips
Never commit real API keys. Provide sanitized `.env.example` snippets for new settings, confirm testnet credentials with `npm run dev:testnet`, and rotate secrets if accidental exposure occurs.
