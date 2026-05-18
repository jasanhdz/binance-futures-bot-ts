# AEGIS Clean Entry Confirmation Guard v1

## Objetivo

Clean Entry Confirmation Guard evita entradas direccionalmente buenas pero tempranas o sucias. No predice dirección: toma una señal ya direccional y decide si está limpia para entrar ahora o si debe esperar confirmación.

En `ENFORCE`, una entrada sucia se convierte en `WAIT_CONFIRMATION` para ese intento. No bloquea el símbolo para siempre; el siguiente tick puede entrar si la señal se limpia.

## Diferencias

- DecisionBrain: decide si hay oportunidad (`ENTER_NOW`, `WAIT_CONFIRMATION`, `DO_NOT_ENTER`, `MANUAL_ONLY`).
- EntryQuality: evalúa calidad técnica/modelo de la entrada.
- Clean Entry Guard: capa posterior que exige que un `ENTER_NOW` también sea limpio.
- Low-MAE Size Guard: limitaría tamaño; esta fase no lo implementa. Aquí una entrada sucia no entra.

## Configuración

```yaml
aegis:
  clean_entry_guard:
    enabled: true
    mode: ENFORCE
    apply_to:
      long: true
      short: true
    dirty_conditions:
      block_when_entry_quality_insufficient: true
      block_when_event_risk_would_block: true
      block_when_tail_risk_gte: 0.45
      block_when_entry_quality_not_allow: true
    clean_conditions:
      require_decision_brain_enter_now: true
      require_entry_quality_allow: true
      require_no_insufficient_data: true
      require_event_risk_would_block_false: true
      max_tail_risk_score: 0.40
```

Defaults de código: `enabled=false`, `mode=SHADOW`, `max_tail_risk_score=0.40`, `block_when_tail_risk_gte=0.45`.

## SHADOW vs ENFORCE

- `SHADOW`: registra `CLEAN_ENTRY_GUARD_SHADOW_ALLOW` o `CLEAN_ENTRY_GUARD_SHADOW_WAIT`, pero no bloquea `marketOpen`.
- `ENFORCE`: registra `CLEAN_ENTRY_GUARD_ALLOW` o `CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION`; si espera confirmación corta antes de `setLeverage`, `ensureMarginType` y `marketOpen`.

## Reasons

- `clean_entry_wait_confirmation`
- `clean_entry_shadow_wait`
- `clean_entry_insufficient_data`
- `clean_entry_event_risk_would_block`
- `clean_entry_tail_risk_high`
- `clean_entry_quality_not_allow`
- `clean_entry_decision_brain_not_enter_now`
- `clean_entry_missing_critical_data`

## Por qué A_PLUS no basta

El análisis offline mostró que `A_PLUS` no redujo MAE de forma consistente. Por eso el guard no permite por grade solamente: exige EntryQuality allow, no `insufficient_data`, EventRisk `wouldBlock=false` y TailRisk bajo.

## Consulta

Los eventos quedan en `logs/aegis/turbo_trade_events_YYYY-MM-DD.jsonl` y se consultan con:

```text
/blocks
/blocks reasons 4h
/blocks detail LINKUSDT
/blocks near-miss 2h
```

No se agregan alertas automáticas de Telegram para estos waits.
