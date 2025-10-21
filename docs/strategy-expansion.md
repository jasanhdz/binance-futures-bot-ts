## Strategy Expansion – Design Blueprint

This document translates the high-level roadmap items into concrete implementation plans. Each section contains:
- **Objective** – what behaviour we expect.
- **Inputs & metrics** – data used by the strategy or gate.
- **Algorithm** – step-by-step pseudocode / logic.
- **Integration tasks** – files to create or modify, plus config knobs, logging, and testing plans.

---

### 1. Trend-Following Playbook
**Objective:** Capture sustained moves after higher-timeframe breakouts, avoiding chop that hurts snapback/momentum strats.

**Inputs & Metrics**
- Timeframes: `entry=5m`, confirmation on `15m` and `1h`.
- Indicators: ATR(14), Supertrend (7, multiplier 3) *or* dual ATR channels.
- Moving averages: EMA 25/99 (trend alignment).
- Volatility filters: 15m ATR % must exceed threshold (e.g., 1%).

**Algorithm Sketch**
```
if supertrend is bullish on 5m AND ema25 > ema99:
    ensure 15m + 1h close above their supertrend lines
    price must break above ATR upper band by buffer (0.5 * ATR)
    confirm volume >= 1.2 * avg20
    require ADX(14) > threshold, avoid if RSI > 80 (overbought filter)
    set stop: lower supertrend or ATR lower band
    take-profit: ATR multiples (e.g., +2 ATR) or trail via supertrend
elif bearish mirror conditions for shorts
```

**Integration Tasks**
1. **Module:** `src/strategies/trend_follow.ts`
   - Export `TrendFollow` implementing `Strategy`.
   - Provide `analyzeTrendFollow` helper (used by scanner / confidence scoring).
2. **Shared utils:** extend `shared/context.ts` or add `shared/indicators.ts` with supertrend + ATR channel calculator.
3. **Config:** add knobs (`TF_SUPERTREND_MULT`, `TF_ATR_FACTOR`, `TF_MIN_ADX`, etc.).
4. **Composite:** update `composeStrategies` in `src/main.ts` to include `TrendFollow`.
5. **Logging/tests:** ensure `signal` reason includes key metrics (ATR %, trend strength). Unit test indicator and evaluation logic.

---

### 2. Slow Mean-Reversion / Rebalance Strategy
**Objective:** Provide a low-frequency strategy for sideways markets; operate when volatility shrinks and price oscillates around a fair value.

**Inputs & Metrics**
- Timeframes: `entry=5m`, confirmation on `30m`.
- Indicators: VWAP (session), Bollinger Bands (20, 2), RSI(14).
- Volume drop-off detection (volume < 0.8 * avg20).
- Range width: BB width must be below threshold (e.g., < 1.5%).

**Algorithm Sketch**
```
detect range: bb_width <= limit AND 30m ATR% < rangeThreshold
if price touches lower band within tolerance AND RSI < 35 AND volume contraction:
    enter LONG; stop = recent swing low, TP = VWAP or mid-band
if price touches upper band AND RSI > 65 AND volume contraction:
    enter SHORT; stop above swing high, TP = VWAP/mid-band
allow only one trade per range leg (cooldown)
```

**Integration Tasks**
1. Create `src/strategies/slow_mean_reversion.ts`.
2. Add indicator utilities: VWAP (intraday) + Bollinger helpers in `core/utils/indicators.ts`.
3. Config entries: `SMR_BB_WIDTH_MAX`, `SMR_RSI_LOW/HIGH`, `SMR_VOL_CONTRACTION`, `SMR_COOLDOWN_MS`.
4. Add to composite strategy list.
5. Additional guard: ensure stop/TP sizing respects min notional; reuse bracket guard.

---

### 3. Signal Confidence & ML Gate
**Objective:** Score each strategy signal and optionally veto low-confidence trades using a classifier fed by recorded features.

**Inputs & Metrics**
- Features from existing logger: streak counts, ATR %, EMA slopes, volume ratios, distance to S/R, ADX, RSI.
- Label data: success of past trades (`signals.ndjson` + PnL).

**Implementation Plan**
1. **Data assembly** (`scripts/export_signals.ts`):
   - Parse `data/signals*.ndjson`, join with trade outcomes to label (win/lose or ROI).
   - Output CSV for experimentation.
2. **Feature enrichment**:
   - Extend signal recorder payload with missing values (ATR %, BB width, etc.).
3. **Model prototyping**:
   - Start with logistic regression (scikit-learn or LightGBM).
   - Train per-strategy models; compute ROC / PR curves.
4. **Runtime gate** (`src/ml/gate.ts`):
   - Load model (e.g., ONNX or simple JSON weights).
   - Provide `evaluate(strategyKey, featureVector) -> {confidence, approve}`.
   - Add config thresholds (`ML_GATE_ENABLED`, `TF_CONFIDENCE_MIN`, etc.).
5. **Integration**:
   - In each strategy’s `evaluate`, compute features, call gate before returning `ENTER_*`.
   - Log confidence score in `signal`.

---

### 4. Adaptive Thresholds / Contextual Parameters
**Objective:** Replace hard-coded thresholds with dynamic values based on volatility and session.

**Components**
- **Volatility scaling**: define baseline ATR (e.g., 30-day average) and compute current ATR ratio.
- **Session detection**: bucket timestamps into Asia / Europe / US (with config for DST).
- **Parameter mapping**: e.g., `MOM_VOL_FACTOR = base * f(volRatio, session)`.

**Implementation Plan**
1. Utility in `core/utils/context.ts`:
   - `getSession(now, timezone)` -> `'ASIA' | 'EU' | 'US'`.
   - `computeVolRatio(candles, baselinePeriod=288)` returning current ATR / baseline.
2. Extend config with base values, e.g., `MOM_VOL_FACTOR_BASE`, `MOM_VOL_FACTOR_VOL_SCALE`, session multipliers.
3. Modify strategy analyzers:
   - Before evaluations, call helper to adjust thresholds (`volFactor`, `roomBuffer`, BB width, etc.).
   - Log adjusted values for debugging.
4. Testing:
   - Unit tests verifying mapping (given vol/session -> expected parameter).
   - Simulation runs to ensure strategy still returns identical decisions when vol ratio = 1.

---

### 5. Supporting Infrastructure
To deliver the above, also schedule these tasks:

| Area | Task | Notes |
|------|------|-------|
| **Indicators** | Implement supertrend, VWAP, Bollinger, ATR channel utilities | Add to `src/core/indicators`. |
| **Logging** | Expand signal recorder payload | Include strategy key, adjusted thresholds, confidence score. |
| **Config/ENV** | Document all new knobs in `ROADMAP.md` or README | Keep `.env.example` updated. |
| **Backtesting** | Add scripts to replay strategies on historical data | Use exported candles; evaluate ROI per playbook. |

---

### Next Steps
1. Prioritise Trend-Follow + ML gate (most impact).  
2. For each module, create a Git branch/issue referencing the tasks above.  
3. Validate with manual backtests or dry runs before enabling in production.  
4. Keep `ROADMAP.md` in sync as milestones complete.
