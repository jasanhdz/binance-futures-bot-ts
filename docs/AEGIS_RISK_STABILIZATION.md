# AEGIS Risk Stabilization v1

## Política operativa actual

Aegis Turbo sigue operando multi-symbol en vivo. La política actual desactiva los caps de portfolio y conserva únicamente un filtro premium para SHORTS.

Profit Protection v1 está activo como capa de salida: no bloquea entradas ni cambia sizing, pero permite mover el SL de posiciones abiertas cuando Break-Even o Exit Eye detectan profit protegible. Ver `docs/AEGIS_PROFIT_PROTECTION.md`.

Clean Entry Confirmation Guard v1 está activo como capa posterior a Decision Enforcement. En `ENFORCE`, una señal aprobada pero sucia se convierte en `WAIT_CONFIRMATION` antes de `setLeverage`/`marketOpen`; no cambia dirección, sizing de entradas limpias, brackets ni salidas. Ver `docs/AEGIS_CLEAN_ENTRY_GUARD.md`.

Las capas de entrada se coordinan desde `aegis.entry_policy`. Esta policy no cambia thresholds ni estrategia; solo define si cada guard corre en `OFF`, `SHADOW` o `ENFORCE`. Ver `docs/AEGIS_ENTRY_POLICY.md`.

Decisión activa:

- Portfolio risk: OFF.
- El bot puede abrir nuevas posiciones aunque ya existan otras abiertas.
- Todos los símbolos pueden participar.
- SHORTS no están apagados.
- SHORTS no tienen size reducido.
- SHORTS deben cumplir señal premium.
- Clean Entry Guard: ENFORCE, exige entrada limpia para LONG/SHORT.

## SHORT premium mode

La sección `aegis.short_gate` controla el filtro quirúrgico para SHORT:

- `enabled`: activa el gate.
- `mode: PREMIUM_ONLY`: exige condiciones premium para SHORT.
- `min_score`: score mínimo para permitir SHORT.
- `require_votes`: votos SHORT mínimos.
- `position_fraction_multiplier`: multiplicador de tamaño para SHORT; política actual `1.0`.
- `max_leverage`: cap máximo de leverage para SHORT.
- `block_symbols`: política actual `[]`, sin símbolos bloqueados por lista.
- `allow_if_regime_bearish`: reservado para una fase posterior con classifier de régimen.

Ejemplos:

- `AVAXUSDT` SHORT con score `0.91` y votos `S=3`: permitido porque `block_symbols: []`.
- `BTCUSDT` SHORT con score `0.84` y votos `S=3`: permitido, con leverage máximo `10x` y size normal.
- `BTCUSDT` SHORT con score `0.79`: bloqueado por `short_score_below_premium_threshold`.
- `BTCUSDT` SHORT con votos `S=2`: bloqueado por `short_votes_below_required`.

## Portfolio risk desactivado

La sección `aegis.portfolio_risk` queda apagada:

```yaml
aegis:
  portfolio_risk:
    enabled: false
```

Con `enabled: false`, el guard no bloquea por:

- número de posiciones abiertas
- posiciones en la misma dirección
- margen usado
- notional/equity

No deberían generarse eventos nuevos `PORTFOLIO_RISK_DENIED` mientras esta sección esté apagada.

## Cómo interpretar blocks

Eventos en `logs/aegis/turbo_trade_events_YYYY-MM-DD.jsonl`:

- `ENTRY_POLICY_DECISION`: trace estandar de todos los guards de entrada.
- `SHORT_GATE_DENIED`: SHORT bloqueado por score o votos.
- `SHORT_GATE_ADJUSTED`: SHORT permitido con metadata de leverage/position fraction original y ajustado.
- `CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION`: señal direccional aprobada, pero entrada no limpia; se espera confirmación.
- `CLEAN_ENTRY_GUARD_ALLOW`: entrada limpia permitida.
- `PORTFOLIO_RISK_DENIED`: no esperado mientras `portfolio_risk.enabled=false`.

Razones principales:

- `short_score_below_premium_threshold`
- `short_votes_below_required`
- `clean_entry_wait_confirmation`
- `clean_entry_insufficient_data`
- `clean_entry_event_risk_would_block`
- `clean_entry_tail_risk_high`
- `clean_entry_quality_not_allow`

## Endurecer o relajar

Más estricto:

- subir `min_score` de `0.80` a `0.85`
- mantener `require_votes: 3`
- bajar `max_leverage`

Más flexible:

- bajar `min_score` a `0.75`
- permitir `require_votes: 2`
- subir `max_leverage`

Para volver a reducir size de SHORTS, bajar `position_fraction_multiplier` por debajo de `1.0`. La política actual lo mantiene en `1.0`.

Para bloquear símbolos específicos en el futuro, agregar símbolos a `block_symbols`. La política actual mantiene `block_symbols: []`.

## Estado v1

La configuración live inicial:

- portfolio risk OFF
- SHORT premium activo: score mínimo `0.80`, votos `3/3`, size `100%`, leverage máximo `10x`
- SHORT blocked symbols: ninguno
- Clean Entry Guard activo en `ENFORCE`
