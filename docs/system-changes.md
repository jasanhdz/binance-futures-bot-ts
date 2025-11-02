# System Change Log

## 2025-11-02 — Post-Exit Re-entry Gate & ML TP Reinforcement

### Resumen de la mejora
- Se añadió memoria post-salida (`postExit*` en `BotState`) para controlar reentradas del mismo lado.
- `StrategyRunner.tick` bloquea nuevas entradas hasta que el precio complete un retroceso válido, rompa el máximo/mínimo o venza un timeout configurable.
- Todos los guardias que cierran posiciones (`take-profit`, `profit-guard`, `intelligent-tp`, `intelligent-tp-ml`) registran precio y hora de salida para alimentar el gate.
- `intelligent-tp-ml` ahora mezcla heurísticas de ROE (caída absoluta/relativa) y velas de reversa con el score ML, forzando cierres cuando la ganancia se erosiona aunque el modelo mantenga sesgo.
- Nuevos parámetros en `CONFIG`: `POST_EXIT_*` para pullback/breakout/timeout y `ML_TP_*` para drop y reversa; permiten afinar la lógica sin tocar código.

### Pseudocódigo simplificado
```pseudo
for each tick(symbol):
  snapshot = state.get()
  if state.mode != IDLE:
    run ML TP guard + profit guard
    return

  price = exchange.markPrice(symbol)
  gate = evaluatePostExitGate(symbol, entrySide, price, snapshot, config)
  if gate.patch: state.set(gate.patch)
  if not gate.allow: return

  signal = strategy.evaluate(...)
  if signal is ENTER:
    size = computeSizing(...)
    openMarketPosition(symbol, side, size)
    state.set({
      mode: side_RIDE,
      lastSide: side,
      lastEntryPrice: entry,
      ...postExitClearPatch()
    })

function evaluatePostExitGate(symbol, side, mark, state, config):
  if postExitSide missing or side changed:
    return allow with clearPatch
  update min/max price since exit using latest candles
  if timeout reached:
    mark gate ready (reason=timeout) and allow
  if pullback reached and rebound confirmed:
    mark gate ready (reason=pullback) and allow
  if breakout over exit price with volumen alto:
    mark gate ready (reason=breakout) and allow
  return block with updated min/max

function intelligentTakeProfitMl(...):
  roe = computeRoe(...)
  update peakRoe
  dropAbs = peak - roe
  dropRel = (peak - roe) / peak
  if dropAbs > ML_TP_DROP_MIN or dropRel > ML_TP_DROP_RATIO:
    performExit('tp_ml_guard_drop')
  if bearish reversal candle with volumen >= ML_TP_REVERSAL_VOL_FACTOR:
    performExit('tp_ml_guard_reversal')
  else evaluate ML weighted score / consensus:
    if hold: keep ride
    if exit: performExit('tp_ml_guard')

function performExit(reason):
  exchange.closeSideMarketSafe(symbol, side)
  finalizeTrade(...)
  state.set({
    mode: IDLE,
    lastExitReason: reason,
    ...postExitSetupPatch(side, exitPrice, now)
  })
```

### Áreas configurables
- `POST_EXIT_PULLBACK_PCT`, `POST_EXIT_REBOUND_PCT`, `POST_EXIT_BREAKOUT_PCT`, `POST_EXIT_TIMEOUT_MS`, `POST_EXIT_BREAKOUT_VOL_FACTOR`.
- `ML_TP_DROP_MIN`, `ML_TP_DROP_RATIO`, `ML_TP_REVERSAL_VOL_FACTOR`, `ML_TP_REVERSAL_BODY_RATIO`.

### Próximos pasos sugeridos
- Afinar thresholds en testnet y revisar logs (`entry_blocked_post_exit`, `tp_ml_force_exit`) para validar timing.
- Ejecutar backtests comparando ROE medio antes/después y proporción de reentradas inmediatas.

## 2025-11-02 — Revert Binance Time Sync Hook

### Resumen
- Se retiró el hook personalizado de sincronización (`getTime`/`ensureTimeSync`) en `BinanceExchange`; volvemos al cliente estándar de `binance-api-node`.
- El `recvWindow` por defecto regresa a 20 000 ms para mantener tolerancia amplia sin ajustar el reloj manualmente.
- `StrategyRunner` no cambió funcionalmente (solo limpieza de espacios); el gate post-salida permanece activo.

### Motivo
- Tras introducir el time sync personalizado, Binance empezó a devolver `Timestamp … outside of the recvWindow` aun estando sincronizados vía NTP. Revertir el cambio evita firmas atrasadas y simplifica el scheduling.

### Seguimiento
- Confiar en la sincronización NTP del sistema (via `sudo sntp -sS`) y, si es necesario, ajustar `BINANCE_RECV_WINDOW` en `.env` en lugar de manipular `getTime`.

## 2025-11-02 — Low-Funds Symbol Gating

### Resumen
- Nuevo umbral (`LOW_FUNDS_WALLET_THRESHOLD`, default `0.2` USDT) controla cuándo evaluar señales.
- `StrategyRunner` consulta el balance USDT; si el símbolo está `IDLE` y la wallet < umbral, se omite el `strategy.evaluate` y se marca `lowFundsActive` en el estado.
- Los símbolos con posiciones abiertas siguen ejecutando guardias y gestión normal.
- Al recuperarse el balance, el flag se limpia y el símbolo vuelve a operar todos los ticks.

### Pseudocódigo
```pseudo
wallet = readWallet()
if state.mode == 'IDLE' and wallet < threshold:
    state.lowFundsActive = true
    log 'low_funds_skip'
    return
else:
    state.lowFundsActive = false
    evaluate strategy & maybe enter trades
```

### Notas
- El balance se lee una sola vez por tick y se reutiliza para el sizing, evitando fetch duplicado.
- Este mecanismo reduce llamadas a señales innecesarias cuando la cuenta se queda sin margen disponible, pero sigue protegiendo las posiciones existentes.

## 2025-11-02 — Symbol Performance Penalties

### Resumen
- Cada cierre de trade graba rendimiento en `data/symbol_performance.json` (victorias/derrotas, historial y métricas básicas).
- Si `pnlUsd <= 0`, el símbolo se agrega a `blocked`; una vez castigado no vuelve a evaluarse en modo `IDLE` hasta eliminación manual del archivo.
- Se registran estadísticas de ganadores (`winners`) y se conserva un historial acotado (default 50 entradas) por símbolo.

### Integración
- `finalizeTrade` computa `pnlUsd`/`roiPct`, actualiza el JSON y loguea `symbol_win_recorded` o `symbol_loss_recorded`.
- `StrategyRunner` consulta `isSymbolBlocked(symbol)` y omite señales si no hay posición abierta.

### JSON de ejemplo
```json
{
  "blocked": ["BTCUSDT"],
  "winners": ["SOLUSDT"],
  "performance": {
    "BTCUSDT": {
      "wins": 1,
      "losses": 3,
      "history": [
        {
          "outcome": "loss",
          "entryTime": 1730500000000,
          "exitTime": 1730501234567,
          "entryPrice": 65000,
          "exitPrice": 64000,
          "qty": 0.01,
          "reason": "stop",
          "roiPct": -5.2,
          "pnlUsd": -32.5
        }
      ]
    }
  }
}
```

### Consideraciones
- Para desbloquear un símbolo basta editar `data/symbol_performance.json` y removerlo de `blocked`.
- Ajusta `SYMBOL_PERF_HISTORY_LIMIT` si necesitas más (o menos) trades almacenados por símbolo.

## 2025-11-02 — ML TP Guard Enhancements

### Resumen
- `intelligentTakeProfitMl` ahora monitorea la pendiente de ROE y el historial de puntuaciones ML (ventana por defecto: 45s).
- Si la ROE cae de forma sostenida (`ML_TP_ROE_SLOPE_THRESHOLD`, `ML_TP_SCORE_DROP_THRESHOLD`) o si la volatilidad (`atr_pct`) se dispara mientras el beneficio se erosiona (`ML_TP_VOLATILITY_EXIT_ATR`), la posición se cierra antes de perder todo el profit.
- Se mantiene un historial in-memory (`roeHistory`) por símbolo; al cerrar se limpia para evitar ruido.
- El logging incluye nuevos campos (`roeSlope`, `scoreSlope`, `atrPct`, `slopeTriggered`, `volatilityTriggered`) para auditar decisiones.

### Configuración clave
- `ML_TP_ROE_SLOPE_WINDOW_MS` (default 45 000) – ventana temporal para evaluar la pendiente.
- `ML_TP_ROE_SLOPE_THRESHOLD` / `ML_TP_SCORE_DROP_THRESHOLD` – degradación mínima de ROE / score para gatillar salida.
- `ML_TP_VOLATILITY_EXIT_ATR` y `ML_TP_VOLATILITY_SLOPE_FACTOR` – condiciones de fuga en escenarios de alta volatilidad.

### Nota
- La lógica sigue respetando `dropTriggered` y `reversalTriggered`; las nuevas condiciones actúan antes de que la ROE viaje a cero, permitiendo cierres “quirúrgicos” en activos volátiles.
- La detección de conflicto ML ahora compara explícitamente 5 m contra 15 m (o el timeframe superior configurado en `ML_CONFLICT_TF`) y bloquea señales con `ml_conflict_block_*` cuando la tendencia mayor contradice al modelo.
- Si el servicio ML no devuelve el timeframe esperado, se registra `ml_conflict_tf_missing` para auditar el origen.
