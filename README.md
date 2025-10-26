# Binance Futures Trading Bot

## Overview
This project implements a multi-strategy Binance Futures trading bot that orchestrates order execution, risk management, and analytics around a shared runtime. The entrypoint (`src/main.ts`) wires configuration, boots a Binance exchange adapter, composes enabled strategies, and spins up per-symbol schedulers. Each tick pulls market context, evaluates strategies, records analytics, and routes trade requests through an exchange abstraction so live trading and simulations can share the same surface.

## Runtime Flow
- **Scheduler** — `src/app/bot.ts` uses `node-cron` to trigger `StrategyRunner.tick` on a fixed cadence (`CONFIG.BOT_INTERVAL_SEC`). Guards enforce state sync, bracket orders, and take-profit logic before strategy evaluation.
- **Strategy Runner** — `src/app/strategy-runner.ts` hydrates the latest candles, account state, and indicators, invokes the composite strategy, and translates `ENTER_*`/`EXIT` signals into Binance API calls, including sizing (`core/risk`), stop placement, and trade bookkeeping.
- **Guards & Risk Controls** — Bracket, pyramid, take-profit (estático e inteligente) y profit-guard módulos bloquean entradas conflictivas, traillean ganancias y mantienen el estado sincronizado con Binance.

## Key Modules
- `src/infra/binance` — Rate-limited REST/WebSocket client with caching for candles, mark prices, leverage brackets, and filters.
- `src/infra/fs` — File system-backed state store (`data/state_*.json`) and structured logger with terminal tables for positions.
- `src/core` — Domain primitives: indicator calculations, risk sizing helpers, analytics writers (`data/orders_book.json`, `trades.ndjson`), and shared types.
- `src/strategies` — Signal engines (trend follow, volatility-adjusted trend ride, momentum breakout, range-to-breakout continuation, break & retest, volume profile pullback, liquidity sweep reversal, funding & basis mean reversion, mean reversion snapback) plus a composite router that stops at the first actionable signal.
- `src/tools` — CLI utilities for scanning markets and running backtests.

## Data & Observability
- **State** — Per-symbol bot state persists under `data/state_<SCOPE>_<SYMBOL>.json`, allowing restarts without losing context.
- **Trades** — Filled entries/exits are appended to `data/orders_book.json` and `data/trades.ndjson` with ROI, filters, and audit metadata for downstream analysis.
- **Logs** — Human-readable logs live in `logs/` with optional ANSI-colored tables for open positions.

## Configuration & Operation
- Configure symbols, leverage, capital allocation, and feature flags via environment variables (`.env`/`.env.testnet`). See `src/infra/config.ts` for the full matrix of supported overrides.
- Intelligent TP tuning: `INT_TP_MIN_ROE`, `INT_TP_TRAIL_DROP`, `INT_TP_TREND_ADX`, `INT_TP_LOOKBACK`, `INT_TP_COOLDOWN_MS` control el mínimo ROI, trailing y sensibilidad de tendencia.
- Common commands:
  - `npm run dev:testnet` — Start the bot against Binance testnet (requires `.env.testnet`).
  - `npm run dev:prod` — Run live with production credentials (`.env`).
  - `npm run build` / `npm run start:testnet|prod` — Compile TypeScript to `dist/` and execute the built output.
  - `npm run test` — Execute Vitest suites colocated with features.
  - `npm run bt` — Launch the TypeScript backtest runner for historical evaluation.

## Extending
Add new strategies under `src/strategies/`, export them from `src/main.ts`, and enrich analytics in `core/analytics`. Use `npm run verify:feats` to regenerate feature vectors when modifying indicator pipelines. Update `AGENTS.md` and `strategies.md` with behavioral notes before submitting changes.
