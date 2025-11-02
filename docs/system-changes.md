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
