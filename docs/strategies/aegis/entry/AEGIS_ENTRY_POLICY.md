# AEGIS Entry Policy

## Objetivo

Entry Policy separa la decision de entrada de la ejecucion. `TradingService` construye un `AegisEntryContext`, llama al orquestador y solo continua hacia `setLeverage`, `ensureMarginType`, `marketOpen` y brackets cuando el resultado final es `ALLOW`.

La capa no toca Binance, no abre ordenes, no cambia sizing por si sola y no modifica estado externo. Su salida es una decision estandar y un trace para logs/reportes.

## Guards

Orden deterministico:

1. `regime_context`
2. `momentum_ride`
3. `regime`
4. `short_gate`
5. `entry_quality`
6. `event_risk`
7. `decision_brain`
8. `clean_entry`
9. `probe_mode`

Cada guard devuelve:

```ts
{
  name: 'clean_entry',
  enabled: true,
  mode: 'ENFORCE',
  decision: 'ALLOW',
  reason: 'allow_clean',
  wouldBlock: false,
  enforced: true,
  metadata: {}
}
```

## Modos

- `OFF`: el guard queda desactivado y no bloquea.
- `SHADOW`: evalua y registra `wouldBlock`, pero no bloquea por si mismo.
- `ENFORCE`: evalua y puede bloquear.

Importante: un guard en `SHADOW` no debe convertirse en bloqueo indirecto por DecisionBrain. Si se quiere bloqueo real, el guard debe estar en `ENFORCE` o el modelo fuente debe producir un hard deny propio.

## Configuracion YAML

Formato preferido:

```yaml
aegis:
  entry_policy:
    enabled: true
    guards:
      regime:
        enabled: true
        mode: SHADOW
      decision_brain:
        enabled: true
        mode: ENFORCE
      entry_quality:
        enabled: true
        mode: ENFORCE
      event_risk:
        enabled: true
        mode: ENFORCE
      clean_entry:
        enabled: true
        mode: ENFORCE
      probe_mode:
        enabled: true
        mode: ENFORCE
      short_gate:
        enabled: true
        mode: ENFORCE
```

Las configs legacy siguen siendo la fuente de parametros finos:

- `aegis.regime_guard`
- `aegis.clean_entry_guard`
- `aegis.probe_mode`
- `aegis.event_risk`
- `aegis.short_gate`
- `aegis.entry_quality_gate`
- `aegis.decision_enforcement`

Si `aegis.entry_policy` no existe, `ConfigLoader` deriva una policy compatible desde esas secciones legacy.

La herencia DRY de YAML esta documentada en [AEGIS_CONFIG_INHERITANCE.md](../../../operations/aegis/AEGIS_CONFIG_INHERITANCE.md).
El orden de resolucion es `defaults < profile < symbol override`, y debe
validarse con `npm run dump:effective-config` antes de promover cambios live.

## Apagar o cambiar un guard

Apagar Clean Entry sin borrar su configuracion:

```yaml
aegis:
  entry_policy:
    guards:
      clean_entry:
        enabled: false
        mode: OFF
```

Poner EventRisk en observacion sin bloquear:

```yaml
aegis:
  entry_policy:
    guards:
      event_risk:
        enabled: true
        mode: SHADOW
```

Poner Regime Guard en observacion, que es el default prudente de v1:

```yaml
aegis:
  entry_policy:
    guards:
      regime:
        enabled: true
        mode: SHADOW
  regime_guard:
    enabled: true
    mode: SHADOW
    source: HYBRID_HEURISTIC
```

Mantener Probe Mode registrando denegaciones sin permitir entradas:

```yaml
aegis:
  entry_policy:
    guards:
      probe_mode:
        enabled: true
        mode: SHADOW
```

## Decision trace

Cada intento relevante genera metadata compacta y trace completo:

```json
{
  "symbol": "ADAUSDT",
  "side": "LONG",
  "turbo": {
    "score": 0.676,
    "votes": { "long": 2, "short": 0, "neutral": 1 },
    "setupGrade": "WEAK"
  },
  "guards": {
    "regime": {
      "mode": "SHADOW",
      "decision": "SHADOW_DENY",
      "reason": "regime_shadow_would_block",
      "metadata": {
        "regime": "CHOP",
        "confidence": 0.7,
        "source": "HYBRID_HEURISTIC"
      }
    },
    "decision_brain": {
      "mode": "ENFORCE",
      "decision": "ALLOW",
      "reason": "enter_now"
    },
    "clean_entry": {
      "mode": "ENFORCE",
      "decision": "WAIT",
      "reason": "clean_entry_event_risk_would_block"
    }
  },
  "finalDecision": "WAIT_CONFIRMATION",
  "finalReason": "probe_min_minutes_between_entries"
}
```

El trace completo va a JSONL. Telegram muestra un resumen compacto para no saturar `/blocks`.

`ENTRY_POLICY_DECISION` incluye tambien un resumen `entryPolicy.regime` con label, confidence, source, BTC/ETH context, tail risk, event risk y razon. Esto deja preparada la base para un dataset de regimen sin cambiar la estrategia live.

## Strategy candidates

Entry Policy puede evaluar candidatos de estrategia además del flujo Aegis normal:

- `aegis_turbo`: candidato normal de Aegis.
- `momentum_ride`: overlay opcional con risk profile propio.

El resultado final expone:

- `strategyCandidates`
- `finalStrategy`: `momentum_ride`, `aegis_turbo` o `none`
- `riskProfile`, solo cuando `finalStrategy=momentum_ride`

`RegimeContext` es middleware informativo. Incluso en `ENFORCE`, no bloquea globalmente;
solo publica metadata para que Momentum Ride evalúe régimen técnico.

Momentum Ride no puede abrir contra Aegis/Turbo ni sobre un `EntryPolicy` final `DENY`.
Un `Momentum DENY` no significa necesariamente que el bot completo haya bloqueado la entrada:
puede significar que Momentum no aplicó y que `aegis_turbo` continuó normalmente. Por eso
`/blocks` reporta bloqueos finales, mientras `/momentum` reporta diagnósticos y oportunidades
Momentum como strategy candidate.

## Agregar un guard futuro

Un guard nuevo debe tener:

- tipo de input derivado desde `AegisEntryContext`
- adapter puro en `src/domain/services/aegis-entry/guards`
- resultado estandar `AegisEntryGuardResult`
- entrada YAML bajo `aegis.entry_policy.guards`
- tests del orquestador para `OFF`, `SHADOW`, `ENFORCE` y orden deterministico

Ejemplo futuro, sin implementarlo ahora:

```yaml
aegis:
  entry_policy:
    guards:
      momentum_ride:
        enabled: true
        mode: SHADOW
```

## Limites

Entry Policy no reemplaza ProfitProtection ni ExitEye. Es solo entrada. Brackets, Break Even, trailing, safe stop moves y salidas siguen fuera de esta capa.
