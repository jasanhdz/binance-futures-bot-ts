# Aegis Telegram Commands

Fecha: 2026-05-07.

El bot puede aceptar comandos de Telegram por long polling. No abre puertos, no usa webhook y no expone HTTP público.

## Activación

Los comandos inbound están apagados por defecto.

Variables:

```bash
TELEGRAM_COMMANDS_ENABLED=1
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
```

Reglas:

- Si `TELEGRAM_COMMANDS_ENABLED` no es `1`, no se inicia el listener inbound.
- Si `TELEGRAM_ALLOWED_CHAT_IDS` está vacío, se autoriza el `TELEGRAM_CHAT_ID` de alertas como fallback.
- Si ambos están vacíos, no se aceptan comandos inbound.
- Si un chat no está autorizado, el bot responde `Unauthorized.` sin datos sensibles.
- Hay rate limit por chat: máximo 1 comando cada 2 segundos.
- El listener usa el mismo `TELEGRAM_BOT_TOKEN` del bot de alertas.

## Seguridad

Todos los comandos actuales son solo lectura.

No implementan:

- abrir operaciones
- cerrar operaciones
- pausar/reanudar trading
- cambiar thresholds
- cambiar YAML
- cambiar flags live
- modificar órdenes Binance
- tocar Python Aegis

## Comandos

```text
/help
/status
/account
/positions
/config
/signal ETHUSDT
/signals
/risk
/brackets
/report today
/blocks
/blocks 4h
/blocks LINKUSDT
/blocks LINKUSDT 6h
/blocks reasons 24h
/blocks symbols
/blocks detail ADAUSDT
/blocks top
/blocks near-miss 2h
/momentum
/momentum 1h
/momentum detail XRPUSDT
/momentum near-miss 2h
/probe
/probe 1h
/probe detail AVAXUSDT
/probe near-miss 24h
```

## Salidas

`/status`

- Bot online/running
- trading mode
- live enabled
- salud de Aegis API
- símbolos activos
- número de posiciones abiertas
- resumen de última señal si está disponible

`/account`

- wallet
- equity total
- disponible
- unrealized PnL
- trades del día
- pérdidas consecutivas
- daily PnL

Los datos no disponibles se muestran como `N/D`.

`/positions`

- posiciones activas por símbolo
- side
- tamaño
- margen
- ROE
- PnL
- duración si existe en state
- TP/SL si Binance los expone

Si no hay posiciones:

```text
💼 POSICIONES ACTIVAS
• Ninguna
```

`/config`

Muestra configuración efectiva de Aegis Turbo:

- `REGIMES.AEGIS_TURBO.entry_threshold`
- leverage
- hard stop ROE
- TP ROE
- trailing activation/callback
- max hold
- `aegis.turbo.enabled`
- `aegis.turbo.live_enabled`
- allow short
- position fraction cap
- max trades per day
- max consecutive losses
- daily loss stop
- cooldown
- require brackets
- close if bracket fails

`/signal SYMBOL`

Consulta Aegis API para un símbolo sin ejecutar operaciones.

Muestra:

- raw action
- gated action
- Turbo score
- threshold efectivo del YAML para el símbolo
- votes
- reason formateado
- freshness
- feature timestamp
- production allowed
- execute/would execute reportado por Python
- CleanEntry si la metadata está disponible en la señal

`/signals`

Consulta todos los símbolos activos. Si falla un símbolo, marca `ERROR` y continúa con los demás.

`/risk`

Muestra:

- trades today y límite
- consecutive losses y límite
- daily PnL y daily loss stop
- cooldown
- liquidity stress si está disponible
- require brackets
- close if bracket fails
- shorts enabled

`/brackets`

Solo lee órdenes abiertas de cierre por símbolo/posición.

Muestra:

- SL activo sí/no
- TP activo sí/no
- precios si están disponibles
- alerta si falta algún bracket

No recrea brackets.

`/report today`

Usa el analyzer local de Aegis Turbo sin shell externo. Lee `logs/aegis/*.jsonl` y responde resumen del día:

- trades
- cerrados
- win rate
- net PnL
- profit factor
- best/worst ROE
- símbolos operados

Si no hay datos:

```text
No hay trades registrados hoy.
```

`/blocks`

Reporte read-only bajo demanda de bloqueos de entrada Aegis. Lee JSONL locales en
`logs/aegis/turbo_trade_events_YYYY-MM-DD.jsonl`; no consulta Binance, no modifica
estado y no ejecuta operaciones.

`/blocks` cuenta bloqueos reales del flujo final de entrada. Diagnósticos de Momentum Ride
no cuentan como bloqueo si `finalDecision=ALLOW` o si `finalStrategy=aegis_turbo` siguió
normalmente. Un `Momentum DENY` significa que Momentum no aplicó; no significa necesariamente
que el bot completo haya denegado la entrada.

Ventanas soportadas:

- `15m`
- `30m`
- `1h`
- `2h`
- `4h`
- `6h`
- `12h`
- `24h`

Default: `1h`. Máximo: `24h`.

Formas:

- `/blocks`: resumen de la última hora para todos los símbolos.
- `/blocks 4h`: resumen de las últimas 4 horas.
- `/blocks LINKUSDT`: resumen de última hora para `LINKUSDT`.
- `/blocks LINKUSDT 6h`: resumen de `LINKUSDT` en 6 horas.
- `/blocks reasons 24h`: ranking por razón de bloqueo.
- `/blocks symbols`: ranking por símbolo.
- `/blocks detail ADAUSDT`: últimos bloqueos relevantes del símbolo.
- `/blocks top`: top combinado de símbolos/razones.
- `/blocks near-miss 2h`: bloqueadas que estuvieron más cerca de pasar.

Eventos y razones incluidas como bloqueos:

- `ENTRY_POLICY_DECISION` cuando `finalDecision` no es `ALLOW`
- `DECISION_ENFORCEMENT_DENIED`
- `ENTRY_QUALITY_GATE_SHADOW_BLOCK`
- `ENTRY_QUALITY_GATE_DENIED`
- `EVENT_RISK_SHADOW_BLOCK`
- `EVENT_RISK_DENIED`
- `CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION`
- `CLEAN_ENTRY_GUARD_SHADOW_WAIT`
- `event_risk_caution_denied_weak_setup`
- `event_risk_caution_would_block_denied`
- `event_risk_risk_off_denied_non_a_plus`
- `entry_quality_shadow_block_hard_denied`
- `decision_brain_wait_confirmation`
- `decision_brain_do_not_enter`
- `decision_brain_manual_only`
- `short_score_below_premium_threshold`
- `short_votes_below_required`
- `turbo_score_below_threshold`
- `raw_would_execute_false`
- `clean_entry_wait_confirmation`
- `clean_entry_shadow_wait`
- `clean_entry_insufficient_data`
- `clean_entry_event_risk_would_block`
- `clean_entry_tail_risk_high`
- `clean_entry_quality_not_allow`
- `clean_entry_decision_brain_not_enter_now`
- `clean_entry_missing_critical_data`

Razones Momentum como `momentum_regime_not_confirmed`, `momentum_turbo_not_confirmed`,
`momentum_turbo_contradict`, `momentum_btc_eth_contradict`, `momentum_tail_risk_high` y
`momentum_safety_cap_exceeded` se excluyen de `/blocks` cuando aparecen solo como diagnóstico
de strategy candidate. Si el evento final queda denegado, `/blocks` cuenta el bloqueo por el
`finalReason` real de `ENTRY_POLICY_DECISION`.

También cuenta eventos permitidos en la misma ventana:

- `GATE_ALLOWED`
- `ORDER_SUBMITTED`
- `POSITION_CONFIRMED`
- `BRACKETS_CONFIRMED`
- `TRADE_CLOSED`

Ejemplo compacto:

```text
🛡️ Bloqueos Aegis — última 1h

Total: 318

Por símbolo:
• LINKUSDT: 72
• ADAUSDT: 61

Por razón:
• entry_quality_shadow_block_hard_denied: 141
• decision_brain_wait_confirmation: 83

Permitidas en ventana:
• GATE_ALLOWED: 2
• ORDER_SUBMITTED: 2
```

`/blocks detail SYMBOL` muestra los últimos eventos relevantes con score, grade,
DecisionBrain, EntryQuality, TailRisk, EntryPolicy y motivo. `/blocks near-miss` ordena candidatos
por `A_PLUS`, score alto, EntryQuality `ALLOW`/`ALLOW_SHADOW` y TailRisk bajo.

Los reportes Telegram son resúmenes operativos. Los logs completos siguen estando en
JSONL para auditoría y análisis offline.

`/momentum`

Reporte read-only de Momentum Ride como strategy candidate. Usa la metadata de
`ENTRY_POLICY_DECISION` y eventos `MOMENTUM_RIDE_DIAGNOSTIC` si existen. No envía alertas
automáticas y no cambia el comportamiento de entrada.

Formas:

- `/momentum`: resumen de la última hora.
- `/momentum 4h`: resumen de las últimas 4 horas.
- `/momentum XRPUSDT`: resumen por símbolo.
- `/momentum detail XRPUSDT`: últimas evaluaciones Momentum del símbolo.
- `/momentum near-miss 2h`: mejores candidatos Momentum de las últimas 2 horas.

El reporte separa:

- oportunidades `SHADOW_ALLOW`
- denies de Momentum por razón diagnóstica
- entradas reales con `finalStrategy=momentum_ride`
- fallback donde Momentum no aplicó y `finalStrategy=aegis_turbo`

Ejemplo compacto:

```text
🎢 Momentum Ride — última 1h

Total evaluaciones Momentum: 12
Patrones detectados: 8
Shadow allow: 3
Shadow deny: 2
Enforce allow: 1
Enforce deny: 4
Final strategy momentum_ride: 1
Final strategy aegis_turbo después de momentum deny: 4

Por razón Momentum:
• momentum_turbo_not_confirmed: 2
• momentum_regime_not_confirmed: 1

Top candidatos:
1) XRPUSDT LONG
Pattern: 3 candles | Vol: 1.80x | Regime: MOMENTUM_UP | Turbo: confirmed | Tail: 0.22 | Decision: SHADOW_ALLOW
   Oportunidad hipotética en shadow
```

`/probe`

Reporte read-only de Probe Mode. Audita evaluaciones permitidas y denegadas, trades abiertos
por Probe, resultados cerrados, TailRisk bands, EventRisk reasons, CleanEntry reasons,
setupGrade, métricas MFE/MAE/ROE y posibles inconsistencias `exit_reason_label_mismatch`.
No cambia thresholds, no cambia YAML y no ejecuta operaciones.

Formas:

- `/probe`: resumen de las últimas 24 horas.
- `/probe 1h`: resumen de la última hora.
- `/probe AVAXUSDT`: resumen de las últimas 24 horas para `AVAXUSDT`.
- `/probe detail AVAXUSDT`: detalle de evaluaciones/trades Probe del símbolo.
- `/probe near-miss 24h`: candidatos Probe permitidos recientes para revisión.

El reporte ayuda a medir si Probe está agregando valor o tomando riesgo malo. También separa
el motivo real de salida del label display cuando encuentra cierres con metadata inconsistente.

## Implementación

Módulos:

- `src/app/telegram/TelegramCommandRouter.ts`
- `src/app/telegram/TelegramCommandHandlers.ts`
- `src/app/telegram/TelegramCommandTypes.ts`
- `src/app/telegram/AegisBlocksReportService.ts`
- `src/app/telegram/AegisMomentumReportService.ts`
- `src/app/telegram/AegisProbeReportService.ts`
- `src/infra/telegram/TelegramBotCommandListener.ts`

El listener se integra en `src/main.ts` solo cuando está activado por env y hay chats autorizados.
