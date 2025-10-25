# Strategy Portfolio

## Snapshot Of Recorded Performance
Closed-trade analytics were computed from `data/orders_book.json` (testnet sample, 12 trades total). Treat the figures as directional only — wallet deltas include fee slippage and some positions exited through safety guards, so ROI can exceed ±100%.

| Strategy                           | Closed Trades | Win Rate | Avg ROI % | Median ROI % | Best ROI % | Worst ROI % |
|------------------------------------|--------------:|---------:|----------:|-------------:|-----------:|------------:|
| Break & Retest                     | 2             | 100%     | 155.92    | 287.97       | 287.97     | 23.87       |
| Range Breakout Continuation        | 0             | —        | —         | —            | —          | —           |
| Liquidity Sweep Reversal           | 0             | —        | —         | —            | —          | —           |
| Volume Profile Pullback            | 0             | —        | —         | —            | —          | —           |
| Funding + Basis Mean Reversion     | 0             | —        | —         | —            | —          | —           |
| Volatility-Adjusted Trend Ride     | 0             | —        | —         | —            | —          | —           |
| Mean Reversion Snap                | 0             | —        | —         | —            | —          | —           |
| Trend Follow                       | 0             | —        | —         | —            | —          | —           |

**Key takeaway:** Break & Retest muestra la señal más consistente en el set actual, aunque la muestra es limitada. Momentum Breakout y VWAP Reversion se retiraron del portafolio hasta rediseñar gestión de riesgo.

---

## Trend Follow (`trend_follow.ts`)
- **Core Idea** — Multi-timeframe trend confirmation using EMA stacks, SuperTrend, ATR expansions, and momentum filters. Entries require alignment across entry timeframe plus two higher confirmations and enforce RSI, volume, and extension thresholds.
- **Strengths** — Structured filter stack reduces chop entries; daily bias gates avoid fighting strong daily moves; integrates higher-timeframe structure and momentum slope checks, which are common best practices in professional crypto trend systems.
- **Weaknesses & Flaws** — No closed trades in the current log set, hinting filters might be too strict (e.g., high ADX requirement combined with tight extension caps). Stop placement ties to SuperTrend without adaptive ATR-based sizing, which could lag during rapid reversals. No explicit trailing or partials beyond global take-profit guard.
- **Market Usage** — EMA + SuperTrend trend strategies are widely used across crypto perpetuals; the combination aligns with standard breakout-following playbooks.
- **What To Improve** — Loosen or make configurable the momentum/extension gates per symbol, add statistical monitoring of filter hit-rate, and backtest optimal ATR multiples for stops to ensure risk/reward stays >1.5.
- **Recommendation** — Collect more trades via controlled backtests before enabling live; consider logging near-miss diagnostics to understand which filter rejects most signals.

## Break & Retest (`break_retest.ts`)
- **Core Idea** — Waits for a breakout above/below recent levels, then validates a retest candle closing in the direction of the breakout with supportive volume, EMA slope, and higher-timeframe trend alignment.
- **Strengths** — Combines price structure with volume and trend checks, mirroring a well-known continuation pattern in crypto swing trading. Current logs show 100% win rate with strong ROI, suggesting the filter stack captures cleaner moves.
- **Weaknesses & Flaws** — Sample size is only two closed trades; lack of explicit stop level beyond global guards; retest tolerance may fail during high-volatility news spikes. Daily pump/drop guards may skip viable counter-trend plays where mean reversion is desirable.
- **Market Usage** — Widely used across futures desks; the implementation aligns with common break-retest criteria (buffer, volume confirmation).
- **What To Improve** — Add automatic stop placement at the retest level minus an ATR buffer, log skipped setups for calibration, and experiment with partial profit targets to lock gains before volatility expansions.
- **Conclusion** — Promote to primary strategy once larger backtest dataset confirms edge; keep monitoring slippage and ensure retention across different symbols.

## Range Breakout Continuation (`range_breakout_continuation.ts`)
- **Core Idea** — Busca compresiones de precio (rango estrecho + ATR deprimido) y opera la expansión cuando el cierre supera el extremo con volumen y tendencia confirmada en marcos superiores.
- **Fortalezas** — Filtra por alineación de EMAs/ADX y exige que la ruptura ocurra tras consolidación real (rango <= umbral, ATR bajo), lo que reduce falsos breakouts y se adapta bien a BTC/ETH.
- **Debilidades & Flaws** — Depende de un único breakout candle; sin stop interno la gestión recae en guardas globales. La detección de consolidación por ATR simple puede necesitar calibración por símbolo.
- **Qué Mejorar** — Añadir cálculo dinámico de reducción de volatilidad (por ejemplo, Bollinger Bandwidth) y fijar stop automático 1–1.5× ATR bajo el rango.
- **Conclusión** — Estrategia con alta probabilidad si se acompaña de stops cortos; priorizar pruebas en mercados con liquidez alta y horarios de sesión activos.

## Liquidity Sweep Reversal (`liquidity_sweep_reversal.ts`)
- **Core Idea** — Identifica barridos de liquidez (mechas que toman el máximo/mínimo previo) con absorción, volumen alto y reversión de RSI cerca de niveles HTF, buscando el giro inmediato al centro del rango.
- **Fortalezas** — Combina wick ratio, spikes de volumen, streak previo y proximidad a soportes/resistencias mayores, replicando setups usados por desks que operan “stop hunts”.
- **Debilidades & Flaws** — Necesita datos de ordenes para mayor precisión; sin confirmaciones adicionales (orderbook delta) puede confundir continuaciones. Requiere stops ajustados (detrás de la mecha) para mantener ventaja.
- **Qué Mejorar** — Integrar métricas de CVD o imbalance y ajustar el umbral de RSI por símbolo/timeframe; considerar TP parcial en el midpoint del rango.
- **Conclusión** — Excelente complemento defensivo cuando Break & Retest o Trend Follow no aplican; asegurarse de parametrizar la distancia a nivel HTF para cada activo.

## Mean Reversion Snapback (`mean_reversion_snapback.ts`)
- **Core Idea** — Looks for exhaustion after extended streaks against the trend: EMA extension beyond a threshold, RSI extremes, multi-timeframe structure support, and reversal candlestick patterns.
- **Strengths** — Rich blend of structure, streak, and candlestick signals; higher-timeframe support checks help avoid catching falling knives; daily bias guard ensures reversals only against over-extended moves.
- **Weaknesses & Flaws** — Currently produces no trades, indicating overly strict conditions (streak + extension + hammer + HTF support may rarely align). Volume “OK” just mirrors reversal pattern, so capitulation scenarios without textbook candles are ignored. No dedicated exit strategy beyond global guards, making risk asymmetric if entries do fire.
- **Market Usage** — Mean-reversion entries around support/resistance with RSI extremes are common in crypto, but practitioners usually combine with order flow or funding metrics.
- **What To Improve** — Relax streak length or allow alternate reversal signals (e.g., bullish divergence), include volatility-weighted take-profit/stop schema, and capture near misses in analytics to tune thresholds.
- **Conclusion** — Needs calibration via backtesting and live paper trades; consider enabling only once filters yield a reasonable number of historical triggers with positive expectancy.

## Composite Router (`composite.ts`)
- **Role** — Evalúa estrategias en orden (Trend Follow → Volatility Trend Ride → Range Breakout Continuation → Break & Retest → Volume Profile Pullback → Liquidity Sweep Reversal → Funding Basis Mean Reversion → Mean Reversion Snapback) y despacha la primera señal ejecutable.
- **Implication** — La prioridad favorece continuidad y pullbacks antes de reversos y mean reversion; revisar métricas periódicas para reordenar según desempeño y evitar bloqueos entre estrategias compatibles.
## Volume Profile Pullback (`volume_profile_pullback.ts`)
- **Core Idea** — Reconstruye el perfil de volumen (POC/Value Area) y busca retrocesos hacia el nodo dominante después de una expansión; confirma con volumen decreciente y tendencia direccional.
- **Fortalezas** — Captura “backfill” hacia zonas de interés institucional, útil en sesiones direccionales donde el precio tiende a retestear el POC antes de continuar; filtros de volumen evitan entrar en reversals abruptos.
- **Debilidades** — Requiere datos de volumen consistentes; un POC amplio o sesgado por velas extremas puede generar falsos positivos. No incluye stops automáticos, por lo que dependes de guardas externas.
- **Qué Mejorar** — Ajustar el número de buckets por símbolo, añadir confirmaciones con delta/CVD y definir stops dinámicos (ej. 1 ATR más allá del POC).
- **Conclusión** — Excelente complemento en mercados de tendencia con retrocesos ordenados; prioriza instrumentos líquidos.

## Funding + Basis Mean Reversion (`funding_basis_mean_reversion.ts`)
- **Core Idea** — Opera contra posicionamientos extremos: si funding y basis se disparan en la misma dirección mientras el precio se sobre-extiende, busca la reversión.
- **Fortalezas** — Se aprovecha de desequilibrios reales en el mercado perp/spot; señales tienden a tener buena probabilidad cuando el crowd está sobreapalancado.
- **Debilidades** — Depende de la latencia de datos de funding/basis; las condiciones extremas pueden persistir, por lo que es crucial mantener tamaño pequeño.
- **Qué Mejorar** — Integrar lectura de open interest o CVD para validar el desequilibrio, y mapear umbrales personalizados por símbolo.
- **Conclusión** — Útil como protección ante manías especulativas; mantener apalancamiento bajo y salidas escalonadas como se describe (1R/2R).

## Volatility-Adjusted Trend Ride (`volatility_trend_ride.ts`)
- **Core Idea** — Extiende Trend Follow con bandas de Keltner/ATR para añadir posiciones solo cuando el precio retrocede dentro de un rango controlado, aplicando trailing stops adaptativos.
- **Fortalezas** — Evita entradas tardías, mejora la gestión de posiciones y habilita piramidación segura; ideal para tendencias fuertes en BTC/ETH.
- **Debilidades** — Sin trailing real implementado dentro de la estrategia, depende de futuras mejoras; puede perder oportunidades si la volatilidad colapsa.
- **Qué Mejorar** — Añadir lógica de trailing/partials en `StrategyRunner` basada en los niveles calculados y calibrar `retraceBand` por activo.
- **Conclusión** — Candidato natural para ser el “core” junto a Trend Follow; recomienda backtesting amplio para definir parámetros por timeframe.
