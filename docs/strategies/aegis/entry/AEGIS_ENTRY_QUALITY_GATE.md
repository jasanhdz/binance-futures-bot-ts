# Aegis EntryQualityGate v0.1

EntryQualityGate observa la limpieza de una entrada Aegis Turbo antes de abrir posicion. El problema que busca medir son senales que pasan los gates actuales, entran al mercado, pero luego tienen mucho MAE, tardan en ponerse verdes o terminan como bad entries.

## Modo SHADOW

`SHADOW` no bloquea entradas reales. Evalua la senal, registra si la habria permitido o bloqueado y deja que el flujo live continue sin cambios hacia sizing, leverage, brackets y `marketOpen`.

Eventos:

- `ENTRY_QUALITY_GATE_SHADOW_ALLOW`
- `ENTRY_QUALITY_GATE_SHADOW_BLOCK`

Cuando aparece `ENTRY_QUALITY_GATE_SHADOW_BLOCK`, la metadata incluye `shadowDidNotBlock: true` para dejar claro que la operacion real no fue impedida.

## Modo ENFORCE

`ENFORCE` bloquea realmente cuando el gate devuelve `allowed=false`. El bloqueo ocurre antes de `setLeverage`, `ensureMarginType` y `marketOpen`.

Eventos:

- `ENTRY_QUALITY_GATE_ALLOW`
- `ENTRY_QUALITY_GATE_DENIED`

`ENFORCE` no esta activado todavia porque el analisis reciente mostro que el score alto no garantiza una buena entrada y que SHORT se comporta peor que LONG. Primero hay que validar en SHADOW si estas reglas reducen MAE, time-to-green y bad-entry rate sin eliminar demasiadas buenas entradas.

## Reglas

- Score minimo: LONG usa `min_score_long`; SHORT usa `min_score_short`.
- Momentum confirmation: LONG requiere retorno reciente >= 0; SHORT requiere retorno reciente <= 0.
- Anti-falling-knife: LONG bloquea caidas recientes mayores al umbral; SHORT bloquea subidas recientes mayores al umbral.
- Overextension: LONG bloquea si el precio esta demasiado por encima de EMA; SHORT si esta demasiado por debajo.
- Volatility: bloquea si `atrPercentile` supera `max_atr_percentile`.
- Flagged symbols 3/3: simbolos marcados requieren 3 votos del lado de entrada.

Si faltan datos de mercado suficientes, el gate devuelve `insufficient_data` y permite la entrada tanto en SHADOW como en ENFORCE.

## Analisis Posterior

Los eventos guardan `symbol`, `side`, `turboScore`, `votes`, `microMomentum`, `recentReturn`, `emaDistance`, `atrPct`, `atrPercentile`, `failedChecks`, `action`, `reason` y `mode`.

Con eso se puede cruzar el historial contra trades reales para medir:

- trades que EntryQualityGate habría bloqueado
- PnL real de esos trades
- MAE de trades bloqueables
- time-to-green
- false positives
- false negatives

## Config Live Actual

`regime_config.live.yaml` deja el gate habilitado en:

```yaml
aegis:
  entry_quality_gate:
    enabled: true
    mode: SHADOW
```

Esto observa el comportamiento sin cambiar la ejecucion live.
