# AEGIS Clean Entry Confirmation Guard v1.1

## Objetivo

Clean Entry Confirmation Guard evita entradas direccionalmente buenas pero tempranas o sucias. No predice direccion: toma una señal ya direccional y decide si esta limpia para entrar ahora o si debe esperar confirmacion.

En `ENFORCE`, una entrada sucia se convierte en `WAIT_CONFIRMATION` para ese intento. No bloquea el simbolo para siempre; el siguiente tick puede entrar si la señal se limpia.

## EntryQuality model vs rule gate

Hay dos señales distintas:

- EntryQuality Python model v020: `aegis.entry_quality_model`. Es la fuente principal de calidad para Clean Entry. Expone `entry_quality_score`, `tail_risk_score`, `recommendation`, `feature_status`, `feature_parity_pct`, `missing_features_count`, `model_scope` y `model_version`.
- EntryQuality TS rule gate: `AegisEntryQualityGate`. Es una regla local legacy basada en contexto TS de velas/EMA/ATR. Su `insufficient_data` significa contexto local insuficiente para esa regla, no que el modelo Python no pueda evaluar.

`feature_status=ok` significa que el runtime Python pudo construir las features criticas del modelo. Clean Entry exige ademas `feature_parity_pct >= min_feature_parity_pct` y scores presentes.

`entryQualityRuleGateReason=INSUFFICIENT_DATA` significa solo "rule gate sin contexto local suficiente". Con modelo Python sano, Clean Entry conserva esa metadata pero no la trata como suciedad fuerte.

## Configuracion

Clean Entry se habilita como guard de entrada desde `aegis.entry_policy.guards.clean_entry`. Sus parametros finos siguen viviendo en `aegis.clean_entry_guard` para compatibilidad.

```yaml
aegis:
  entry_policy:
    guards:
      clean_entry:
        enabled: true
        mode: ENFORCE
```

```yaml
aegis:
  clean_entry_guard:
    enabled: true
    mode: ENFORCE
    use_entry_quality_model_as_source_of_truth: true
    ignore_rule_gate_insufficient_data_when_model_ok: true
    min_feature_parity_pct: 95
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

Defaults de codigo: `enabled=false`, `mode=SHADOW`, `use_entry_quality_model_as_source_of_truth=true`, `ignore_rule_gate_insufficient_data_when_model_ok=true`, `min_feature_parity_pct=95`, `max_tail_risk_score=0.40`.

## Decision

Clean Entry bloquea por features del modelo cuando falta `entry_quality_model`, `feature_status != ok`, `feature_parity_pct < 95`, `entry_quality_score` falta o `tail_risk_score` falta.

Si el modelo esta sano, `recommendation` es `ALLOW` o `ALLOW_SHADOW`, `tail_risk_score <= max_tail_risk_score` y EventRisk no bloquearia, entonces la entrada puede ser `ALLOW_CLEAN` aunque el rule gate TS diga `INSUFFICIENT_DATA`.

Si EventRisk marca `wouldBlock=true`, Clean Entry puede seguir esperando confirmacion aunque EntryQuality Python este sano.

Cuando ignora `INSUFFICIENT_DATA` del rule gate por modelo sano, la metadata incluye:

```text
clean_entry_rule_gate_insufficient_context_ignored_due_to_model_ok: true
```

## Metadata

Clean Entry separa los nombres del modelo y del rule gate:

- `entryQualityModelFeatureStatus`
- `entryQualityModelFeatureParityPct`
- `entryQualityModelRecommendation`
- `entryQualityModelScore`
- `tailRiskScore`
- `entryQualityRuleGateReason`
- `entryQualityRuleGateDecision`

Los aliases legacy `entryQualityRecommendation`, `entryQualityScore` y `entryQualityGateReason` se mantienen para compatibilidad de reportes.

## Reasons

Reasons principales:

- `clean_entry_event_risk_would_block`
- `clean_entry_rule_gate_insufficient_context`
- `clean_entry_model_features_missing`
- `clean_entry_model_block_shadow`
- `clean_entry_tail_risk_high`
- `clean_entry_decision_brain_not_enter_now`
- `clean_entry_missing_critical_data`

`clean_entry_rule_gate_insufficient_context` aparece solo cuando el modelo Python no es fuente valida, o cuando la config desactiva ignorar `INSUFFICIENT_DATA` del rule gate.

## SHADOW vs ENFORCE

- `SHADOW`: registra `CLEAN_ENTRY_GUARD_SHADOW_ALLOW` o `CLEAN_ENTRY_GUARD_SHADOW_WAIT`, pero no bloquea `marketOpen`.
- `ENFORCE`: registra `CLEAN_ENTRY_GUARD_ALLOW` o `CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION`; si espera confirmacion corta antes de `setLeverage`, `ensureMarginType` y `marketOpen`.

Dentro de Entry Policy, `OFF`, `SHADOW` y `ENFORCE` se controlan desde `aegis.entry_policy.guards.clean_entry`. Ver `docs/AEGIS_ENTRY_POLICY.md`.

## /blocks

Los eventos quedan en `logs/aegis/turbo_trade_events_YYYY-MM-DD.jsonl` y se consultan con:

```text
/blocks
/blocks reasons 4h
/blocks detail LINKUSDT
/blocks near-miss 2h
```

Para eventos `CLEAN_ENTRY_GUARD_*`, `/blocks` prioriza la razon especifica dentro de `cleanEntryGuard.reasons`. Asi un ADA-like con modelo `ALLOW`, tail bajo, rule gate `INSUFFICIENT_DATA` y EventRisk `wouldBlock=true` se ve como `clean_entry_event_risk_would_block`, no como insufficient data.
