## Trading System Roadmap

This roadmap captures the improvement plan we just discussed. Each milestone explains **why** it matters, expected deliverables, and recommended action steps so you can tackle it incrementally without losing sight of the long-term goal.

---

### Milestone 1 — Expand Playbook Coverage
**Goal:** Reduce idle time and diversify trade logic by adding uncorrelated strategies.  
**Why:** Your current stack (momentum, break/retest, snapback) is strong but still has blind spots (e.g., low-vol regimes, deep trends). More playbooks lets you stay active in different markets.
**Tasks**
- **Trend-following module** (e.g., ATR channels, moving-average crossover with trailing stop).  
  - Define entry/exit rules (add to `src/strategies`).  
  - Decide risk parameters and guard compatibility.  
  - Integrate into `composeStrategies`.
- **Range scalper / mean-reversion** for quiet sessions.  
  - Works alongside your snapback but uses channel or oscillator signals.  
  - Needs strict guard settings (tight stops, small sizing).
- **Schedule & Review**  
  - For each new playbook, log expected conditions, gating metrics, and plan A/B tests.

---

### Milestone 2 — Signal Quality & ML Gate
**Goal:** Filter out low-confidence trades automatically.  
**Why:** Recording signals is great, but using them to train a gate can weed out bad setups before risk is taken.
**Tasks**
- **Feature inventory:** Ensure the signal recorder captures all features you need (distance to EMA, trend slopes, volume spikes, etc.).  
- **Data pipeline:** Build a notebook or script to export trades and labels (`src/scanner`) for analysis.  
- **Classifier / calibration:** Start with a simple logistic regression or gradient boosting model; use probability thresholds tightened per strategy.  
- **Integration:** Wrap the gate in a helper module so each playbook can be checked (`if (mlGate(strategy, context) < threshold) skip`).

---

### Milestone 3 — Adaptive Risk & Capital Management
**Goal:** Adjust leverage/position sizing based on global account risk and market conditions.  
**Why:** Static parameters can over- or under-allocate; adaptive controls maintain consistency as volatility shifts.
**Tasks**
- **Drawdown guard:** Already partially implemented; add reporting and auto cooldown when triggered (store metrics in state/log).  
- **Volatility-aware sizing:** Tie capital usage to ATR or realized volatility; e.g., reduce capital when volatility is high.  
- **Symbol ranking to sizing:** Use scanner outputs to bias allocations (top-ranked symbols get more size).  
- **Multi-strategy scheduler:** Optionally manage concurrency (e.g., limit simultaneous trades).

---

### Milestone 4 — Execution Resilience
**Goal:** Make the execution layer fault-tolerant and rate-limit safe.  
**Why:** REST-only mode helps, but you need backoff strategies and fallbacks to stay robust.
**Tasks**
- **Retry/backoff logic:** Wrap key REST calls with automatic retries (exponential backoff).  
- **Rate-limit monitor:** Already logging; extend with metrics (counts, durations) and staggered scheduling.  
- **Data fallback:** If mark price is stale, derive from last candle mid; log this behavior.  
- **Symmetric API usage:** Ensure cancels/updates follow the same protective patterns.

---

### Milestone 5 — Performance Analytics & Dashboard
**Goal:** Build visibility into strategy performance and health.  
**Why:** You need data to decide when to tune, disable, or double down on a playbook.
**Tasks**
- **Metrics pipeline:** Consolidate `signals.ndjson` into daily/weekly summaries (win rate, ROI, hold time).  
- **Dashboard or report:** Simple CLI table or HTML view showing the stats per strategy/timeframe.  
- **Anomaly alerts:** Watch for unusual behavior (e.g., spike in losses) with simple threshold-based alerts.

---

### Milestone 6 — Automatic Symbol Rotation
**Goal:** Keep your symbol list fresh based on scanner data.  
**Why:** Static symbol lists can rot; you might miss newly active markets.
**Tasks**
- **Scanner output persistence:** Already implemented via `--save`; parse those JSON files regularly.  
- **Promotion/demotion rules:** Define scores or thresholds for adding/removing symbols.  
- **Config updater:** Script that updates `.env` or a config file and restarts the bot safely.

---

### Milestone 7 — Strategy Lab Workflow
**Goal:** Make new ideas easy to prototype, deploy, and retire.  
**Why:** A repeatable workflow keeps experiments and production in sync.
**Tasks**
- **Strategy template:** Create a boilerplate strategy module with comments/placeholders.  
- **Backtest harness:** Hook into historical data (already partly present) for quick evaluation.  
- **Automated tests:** Add unit/integration tests to ensure strategies respect guard contracts and configs.

---

### Next Actions
1. Review this roadmap and adjust priorities based on your trading objectives (e.g., focus on Milestone 1 first).  
2. Create Git issues or project board items for each task. Assign initial deadlines/owners if others will collaborate.  
3. For each milestone, verify logging/telemetry is sufficient before deploying any code; measuring impact is crucial.  
4. Schedule regular reviews (weekly/bi-weekly) to evaluate strategy performance and revisit parameters.

You can now iterate milestone by milestone. When you’re ready to implement any specific step, bring it up and we’ll dive into the coding work together.
