# Aegis Event Risk Overlay v0.1

## Objetivo

Aegis Event Risk Overlay agrega una capa manual/configurable para cambiar el modo de riesgo de nuevas entradas cuando hay riesgo externo: noticias, sesiones macro, fallas de conectividad, eventos de exchange o condiciones donde el trader quiere bajar exposición.

Esta capa no predice mercado, no decide dirección y no abre ni cierra trades. Solo evalúa si una nueva entrada automática debería operar normal, quedar marcada como cautela, quedar marcada como riesgo alto o requerir aprobación manual.

## Modos

- `NORMAL`: el bot opera como antes.
- `CAUTION`: nuevas entradas siguen permitidas, pero se registran como entradas que requieren mayor calidad.
- `RISK_OFF`: nuevas entradas se tratan como high risk. En v0.1 queda en shadow por defecto y registra si habría bloqueado por no ser A+.
- `MANUAL_ONLY`: nuevas entradas automáticas quedan marcadas como manual-only. Solo bloquea si `enforce=true` y `manual_only.block_new_entries=true`.

## Shadow Primero

Por defecto `enforce=false`, así que el overlay no bloquea live. Esto permite comparar si el overlay habría evitado malas entradas sin cambiar todavía el comportamiento productivo.

Eventos de history:

- `EVENT_RISK_SHADOW_ALLOW`
- `EVENT_RISK_SHADOW_CAUTION`
- `EVENT_RISK_SHADOW_BLOCK`
- `EVENT_RISK_DENIED`
- `EVENT_RISK_MODE_CHANGED`

## Configuración

`regime_config.live.yaml`:

```yaml
aegis:
  event_risk:
    enabled: true
    mode: NORMAL
    enforce: false
    manual_override_enabled: true
    caution:
      min_quality_score: 0.65
      max_tail_risk_score: 0.45
      require_btc_eth_confirmation: true
    risk_off:
      min_quality_score: 0.75
      max_tail_risk_score: 0.35
      allow_only_a_plus: true
    manual_only:
      block_new_entries: false
```

Defaults de código si falta YAML:

- `enabled=false`
- `mode=NORMAL`
- `enforce=false`
- `manual_only.block_new_entries=false`

## Telegram

Lectura:

- `/risk`
- `/config`
- `/riskmode`

Cambio runtime seguro si el chat está autorizado y `manual_override_enabled=true`:

- `/riskmode NORMAL`
- `/riskmode CAUTION`
- `/riskmode RISK_OFF`
- `/riskmode MANUAL_ONLY`

El cambio por Telegram es runtime/in-memory. El valor persistente sigue siendo el YAML.

## Revisión De Logs

Buscar en history:

```bash
rg 'EVENT_RISK_' logs/history-YYYY-MM-DD.log
```

Campos principales:

- `mode`
- `enforce`
- `symbol`
- `side`
- `turboScore`
- `entryQualityScore`
- `tailRiskScore`
- `btcAction` / `btcScore`
- `ethAction` / `ethScore`
- `reason`

## Alcance v0.1

No toca modelos Python, Aegis API, PM2, `.env` ni órdenes manuales. La integración vive solo del lado TS antes de `marketOpen`.

## Auto Detector SHADOW

`Aegis Event Risk Auto Detector v0.1` vive del lado Python y aparece en `/ml-v2/predict` como:

```json
{
  "aegis": {
    "event_risk_auto": {
      "mode": "SHADOW",
      "suggested_mode": "CAUTION",
      "confidence": 0.72,
      "reasons": ["btc_weak_or_hold"],
      "execute": false,
      "production_allowed": false,
      "does_not_change_event_risk_mode": true
    }
  }
}
```

La diferencia clave:

- `event_risk.mode` es el modo real actual del overlay manual/configurable.
- `event_risk_auto.suggested_mode` es solo una sugerencia automática en shadow.

El detector automático no cambia el modo real, no bloquea entradas y no decide dirección. Usa contexto estructurado local de BTC/ETH/turbo/frescura/modelos shadow cuando está disponible. No usa noticias, scraping ni APIs externas en v0.1.

También aparece en `/debug/runtime`:

```json
{
  "event_risk_auto": {
    "last_suggested_mode": "CAUTION",
    "confidence": 0.72,
    "reasons": ["btc_weak_or_hold"],
    "last_update": "2026-05-14T00:00:00+00:00",
    "cache_status": {"status": "warm", "evaluations": 1}
  }
}
```

En Telegram, `/signal SYMBOL` muestra una línea opcional:

```text
EventRisk: CAUTION 72.0%
```

Para analizar:

```bash
rg '"event_risk_auto"' logs/aegis/turbo_shadow_$(date -u +%Y%m%d).jsonl
```
